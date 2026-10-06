import type { Request, Response, NextFunction } from "express";

// Request rate limit for GET /photos/:id/graph, which can run dozens of
// queries per call. In-memory and per-process.
// Keyed by user and organization (not IP — tenants share NATs).
//
//   GRAPH_RATE_LIMIT_PER_USER   requests per user per window (default 120)
//   GRAPH_RATE_LIMIT_PER_ORG    requests per org per window (default 600)
//   GRAPH_RATE_WINDOW_SEC       window in seconds (default 60)

/** At depth 2 the per-thread neighbour count is capped to bound query fan-out. */
export const GRAPH_DEPTH2_MAX_PER_THREAD = 6;

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const hits = new Map<string, number[]>();

function waitSeconds(key: string, max: number, windowMs: number, now: number): number {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  hits.set(key, recent);
  return recent.length >= max ? Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000)) : 0;
}

/** Mount after requireOrgAuth. A rejected request is not recorded. */
export function graphRateLimit(req: Request, res: Response, next: NextFunction): void {
  const maxUser = envInt("GRAPH_RATE_LIMIT_PER_USER", 120);
  const maxOrg = envInt("GRAPH_RATE_LIMIT_PER_ORG", 600);
  const windowMs = envInt("GRAPH_RATE_WINDOW_SEC", 60) * 1000;
  const now = Date.now();
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= windowMs)) hits.delete(key);
    }
  }
  const orgKey = `org:${req.org!.id}`;
  const userKey = `user:${req.dbUser!.id}`;
  const wait = Math.max(waitSeconds(orgKey, maxOrg, windowMs, now), waitSeconds(userKey, maxUser, windowMs, now));
  if (wait > 0) {
    res.setHeader("Retry-After", String(wait));
    res.status(429).json({ error: "Too many graph requests. Please wait a moment and try again.", code: "graph_rate_limited", retryAfterSeconds: wait });
    return;
  }
  hits.get(orgKey)!.push(now);
  hits.get(userKey)!.push(now);
  next();
}

/** Test hook: forget all rate-limit history. */
export function resetGraphRateLimit(): void {
  hits.clear();
}
