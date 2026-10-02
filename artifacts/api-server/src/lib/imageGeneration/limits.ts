import type { Request, Response, NextFunction } from "express";

// Abuse / fairness limits for AI image generation (#229). Generation runs
// through one process-wide queue (2 concurrent model calls) that holds
// reference images in memory, so without limits one org can starve every
// tenant and grow the heap. Everything here is in-memory and per-process,
// matching the single-instance deployment and the queue it protects.
//
//   GENERATION_MAX_PENDING_PER_ORG    pending+running jobs per organization (default 6)
//   GENERATION_MAX_PENDING_PER_USER   pending+running jobs per user (default 4)
//   GENERATION_MAX_QUEUE              pending+running jobs across all orgs (default 40)
//   GENERATION_RATE_LIMIT_PER_ORG     plan/generate requests per org per window (default 40)
//   GENERATION_RATE_LIMIT_PER_USER    plan/generate requests per user per window (default 20)
//   GENERATION_RATE_WINDOW_SEC        rate-limit window in seconds (default 600)

export const GENERIC_GENERATION_ERROR = "Image generation failed. Please try again.";

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Read on each call so tests (and operators restarting with new env) see
// current values without module-load ordering concerns.
function limits() {
  return {
    perOrg: envInt("GENERATION_MAX_PENDING_PER_ORG", 6),
    perUser: envInt("GENERATION_MAX_PENDING_PER_USER", 4),
    queue: envInt("GENERATION_MAX_QUEUE", 40),
    rateOrg: envInt("GENERATION_RATE_LIMIT_PER_ORG", 40),
    rateUser: envInt("GENERATION_RATE_LIMIT_PER_USER", 20),
    windowMs: envInt("GENERATION_RATE_WINDOW_SEC", 600) * 1000,
  };
}

export type GenerationLimitCode = "generation_busy" | "generation_rate_limited" | "generation_queue_full";

export class GenerationLimitError extends Error {
  readonly statusCode = 429;
  constructor(
    message: string,
    readonly code: GenerationLimitCode,
    readonly retryAfterSec: number,
  ) {
    super(message);
  }
}

// --- Pending-job accounting -------------------------------------------------

const pendingByOrg = new Map<number, number>();
const pendingByUser = new Map<number, number>();
let pendingTotal = 0;

function bump(map: Map<number, number>, key: number, by: number) {
  const next = (map.get(key) ?? 0) + by;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

// Rough wait hint: jobs take 15-60s and 2 run at once.
function retryAfterFor(ahead: number): number {
  return Math.min(300, Math.max(15, Math.ceil(ahead / 2) * 30));
}

/** Throws a GenerationLimitError when `count` more jobs wouldn't fit. */
export function assertGenerationCapacity(organizationId: number, userId: number, count = 1): void {
  const l = limits();
  const org = pendingByOrg.get(organizationId) ?? 0;
  if (org + count > l.perOrg) {
    throw new GenerationLimitError(
      "Your organization already has the maximum number of images generating. Wait for some to finish, then try again.",
      "generation_busy",
      retryAfterFor(org),
    );
  }
  const user = pendingByUser.get(userId) ?? 0;
  if (user + count > l.perUser) {
    throw new GenerationLimitError(
      "You already have the maximum number of images generating. Wait for some to finish, then try again.",
      "generation_busy",
      retryAfterFor(user),
    );
  }
  if (pendingTotal + count > l.queue) {
    throw new GenerationLimitError(
      "Image generation is very busy right now. Please try again in a minute.",
      "generation_queue_full",
      retryAfterFor(pendingTotal),
    );
  }
}

/** Check and reserve `count` job slots (synchronous, so it can't race). */
export function reserveGenerationSlots(organizationId: number, userId: number, count: number): void {
  assertGenerationCapacity(organizationId, userId, count);
  bump(pendingByOrg, organizationId, count);
  bump(pendingByUser, userId, count);
  pendingTotal += count;
}

/** Give back slots when a job finishes, fails, or is never started. */
export function releaseGenerationSlots(organizationId: number, userId: number, count = 1): void {
  bump(pendingByOrg, organizationId, -count);
  bump(pendingByUser, userId, -count);
  pendingTotal = Math.max(0, pendingTotal - count);
}

// --- Request rate limit -----------------------------------------------------

const hits = new Map<string, number[]>();

// Seconds until `key` may make another request (0 = allowed now).
function waitSeconds(key: string, max: number, windowMs: number, now: number): number {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  hits.set(key, recent);
  return recent.length >= max ? Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000)) : 0;
}

/**
 * Per-org and per-user request rate limit for the plan/generate endpoints
 * (the client IP is not the key — tenants share NATs, and abusers rotate).
 * Mount after requireOrgAuth. A rejected request is not recorded.
 */
export function generationRateLimit(req: Request, res: Response, next: NextFunction): void {
  const l = limits();
  const now = Date.now();
  // Opportunistic sweep so the Map can't grow unbounded.
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= l.windowMs)) hits.delete(key);
    }
  }
  const orgKey = `org:${req.org!.id}`;
  const userKey = `user:${req.dbUser!.id}`;
  const wait = Math.max(waitSeconds(orgKey, l.rateOrg, l.windowMs, now), waitSeconds(userKey, l.rateUser, l.windowMs, now));
  if (wait > 0) {
    sendLimit(
      res,
      new GenerationLimitError("You're generating too quickly. Please wait a bit before trying again.", "generation_rate_limited", wait),
    );
    return;
  }
  hits.get(orgKey)!.push(now);
  hits.get(userKey)!.push(now);
  next();
}

// --- Responses --------------------------------------------------------------

function sendLimit(res: Response, error: GenerationLimitError): void {
  res.setHeader("Retry-After", String(error.retryAfterSec));
  res.status(429).json({ error: error.message, code: error.code, retryAfterSeconds: error.retryAfterSec });
}

/**
 * Shared error responder for the generation routes: limit errors become 429s,
 * deliberate 4xx errors keep their (validation) message, and anything else is
 * logged in full but answered with a generic message — raw provider/database
 * errors never reach the client.
 */
export function sendGenerationError(req: Request, res: Response, error: unknown, genericMessage: string, logMessage: string): void {
  if (error instanceof GenerationLimitError) {
    sendLimit(res, error);
    return;
  }
  const status = (error as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) {
    req.log.error({ err: error }, logMessage);
    res.status(status).json({ error: genericMessage });
    return;
  }
  res.status(status).json({ error: error instanceof Error ? error.message : genericMessage });
}

/** Test hook: forget all counters and rate-limit history. */
export function resetGenerationLimits(): void {
  pendingByOrg.clear();
  pendingByUser.clear();
  pendingTotal = 0;
  hits.clear();
}
