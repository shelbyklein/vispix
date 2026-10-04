import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, customFetch } from "./custom-fetch";

// AI image generation — the Create workspace (#167). Hand-written hooks over
// the /api/image-generation routes (same pattern as organizations.ts).

export type GenerationInputKind = "upload" | "photo" | "asset";
export type GenerationInputRole = "style" | "hero_photo" | "exact_asset";
// Exactly the image model's native canvases — no fake ratios.
export type GenerationFormatId = "1:1" | "2:3" | "3:2";

// ---- #215 asset fidelity contract (docs/IMAGE_FIDELITY.md) ----------------
// Optional until both lanes land; old generations have none of these.

/** Roles a plan may mark as required before generating. */
export type RequiredInputRole = "hero_photo" | "exact_asset";

/** A required input the plan looked for (Lane B). */
export interface RequiredInput {
  role: RequiredInputRole;
  /** Human label of the slot, e.g. "Primary logo". */
  slot: string;
  status: "found" | "missing" | "ambiguous";
  message: string;
}

/** An exact logo composited from the original file (Lane A). */
export interface GenerationComposition {
  mode: "exact_logo";
  assetId: number;
  assetName: string;
  /** Identifies the exact file revision used (e.g. storage key + content hash). */
  assetRevision: string;
  /** Pixel box on the final image. */
  layout: { x: number; y: number; width: number; height: number };
  /** Where the box came from: the model's placeholder, or the default corner. */
  placement: "model_placeholder" | "default_corner";
}

/** How a generation was made (Lane A). */
export interface GenerationFidelity {
  composition: GenerationComposition | null;
  /** "reinterpreted" when a hero photo was redrawn by the model (not pixel-exact). */
  photoTreatment: "reinterpreted" | null;
  /** Required inputs the person chose to continue without. */
  grounding: { acknowledgedMissing: RequiredInputRole[] };
  /** Canvas asked for vs rendered; supported=false when it had to change. */
  formatResolution: { requested: string; rendered: GenerationFormatId; supported: boolean } | null;
  provenance: { model: string | null; settings: Record<string, unknown> } | null;
}

/** Error body when a required input is missing and not acknowledged (409). */
export interface InputRequiredError {
  error: string;
  code: "input_required";
  missing: RequiredInput[];
}

export interface GenerationRequestInput {
  kind: GenerationInputKind;
  refId?: number;
  storageKey?: string;
  role: GenerationInputRole;
  name?: string;
}

export interface ImageGenerationResult {
  id: number;
  sessionId: number;
  parentGenerationId: number | null;
  prompt: string;
  settings: { format?: GenerationFormatId; variantIndex?: number; variantCount?: number; imageModel?: string };
  inputs: { kind: GenerationInputKind; refId: number | null; storageKey: string; role: GenerationInputRole; name: string | null }[];
  usageNotesSnapshot: string[];
  storageKey: string | null;
  imageUrl: string | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
  status: "pending" | "succeeded" | "failed";
  error: string | null;
  createdAt: string;
  /** #215: present on generations made after asset fidelity shipped. */
  fidelity?: GenerationFidelity;
}

export interface GenerationSessionSummary {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationSessionDetail extends GenerationSessionSummary {
  generations: ImageGenerationResult[];
}

export interface GenerateImagesBody {
  sessionId?: number;
  parentGenerationId?: number;
  prompt: string;
  /** Omit on a revision to inherit the parent's format; set to re-render the
   * design on a different canvas. */
  format?: GenerationFormatId;
  variantCount: number;
  inputs: GenerationRequestInput[];
  /** #215: required inputs the person explicitly chose to go without. */
  acknowledgedMissing?: RequiredInputRole[];
}

/**
 * The server's 429 for generation limits (#229): too many jobs in flight, too
 * many requests, or a full queue. Returns its user-facing message, else null.
 */
export function getGenerationLimit(err: unknown): { code: string; message: string; retryAfterSeconds: number | null } | null {
  if (!(err instanceof ApiError) || err.status !== 429) return null;
  const data = err.data as { error?: unknown; code?: unknown; retryAfterSeconds?: unknown } | null;
  if (typeof data?.code !== "string" || !data.code.startsWith("generation_") || typeof data.error !== "string") return null;
  return {
    code: data.code,
    message: data.error,
    retryAfterSeconds: typeof data.retryAfterSeconds === "number" ? data.retryAfterSeconds : null,
  };
}

const SESSIONS_KEY = ["image-generation", "sessions"] as const;

export function getGenerationSessionQueryKey(id: number | undefined) {
  return ["image-generation", "session", id ?? null] as const;
}

export function useGenerationSessions() {
  return useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: () => customFetch<GenerationSessionSummary[]>("/api/image-generation/sessions"),
  });
}

export function useGenerationSession(id: number | undefined) {
  return useQuery({
    queryKey: getGenerationSessionQueryKey(id),
    queryFn: () => customFetch<GenerationSessionDetail>(`/api/image-generation/sessions/${id}`),
    enabled: id != null,
    // Generation is async (#189): the generate call returns pending rows and a
    // background worker fills them in — poll while any are still pending.
    refetchInterval: (query) =>
      query.state.data?.generations.some((g) => g.status === "pending") ? 2500 : false,
  });
}

export function useGenerateImages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: GenerateImagesBody) =>
      customFetch<{ sessionId: number; generations: ImageGenerationResult[] }>(
        "/api/image-generation/generate",
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
      queryClient.invalidateQueries({ queryKey: getGenerationSessionQueryKey(result.sessionId) });
    },
  });
}

export function generationDownloadUrl(id: number, format: "png" | "jpg"): string {
  return `/api/image-generation/${id}/download?format=${format}`;
}

// Collaborative planning (#167 §3–4): the assistant analyzes the prompt,
// proposes library candidates per slot, and asks clarifying questions.

export interface PlanCandidate {
  kind: "photo" | "asset";
  refId: number;
  name: string;
  previewUrl: string;
  role: GenerationInputRole;
  // Asset candidates (#206): what the asset is and why it was suggested.
  variant?: string | null;
  notes?: string | null;
  isPrimary?: boolean;
  reasons?: string[];
  confidence?: "high" | "medium" | "low";
  /** Photo candidates (#207): explicit rights state; not_recorded = unknown. */
  usageRights?: { status: "recorded" | "not_recorded"; tags: { id: number; name: string }[] };
  /** Photo candidates (#207): AI quality, or null when not evaluated. */
  quality?: { overallScore: number } | null;
}

export interface PlanCandidateSlot {
  slot: string;
  role: GenerationInputRole;
  query: string;
  items: PlanCandidate[];
}

export interface GenerationPlan {
  summary: string;
  questions: string[];
  suggestedFormat: GenerationFormatId | null;
  slots: PlanCandidateSlot[];
  /** #215: inputs this design needs; Generate stays blocked while any is missing/ambiguous and unacknowledged. */
  requiredInputs?: RequiredInput[];
}

export function usePlanGeneration() {
  return useMutation({
    mutationFn: (body: { prompt: string; attachedNames: string[] }) =>
      customFetch<GenerationPlan>("/api/image-generation/plan", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });
}

// Past generations (#194): a read-only gallery of every completed generation in
// the org, newest first, paged with an opaque cursor. Generated images are not
// photos, so they are never analysed, embedded or searchable.

export interface PastGeneration {
  id: number;
  imageUrl: string | null;
  prompt: string;
  format: GenerationFormatId | null;
  width: number | null;
  height: number | null;
  status: "succeeded" | "failed";
  createdAt: string;
  /** Rights of each photo input, frozen at generation time (#207). */
  rightsConsidered: {
    photoId: number;
    name: string;
    status: "recorded" | "not_recorded";
    tags: { id: number; name: string }[];
    checkedAt: string;
  }[];
  creator: { id: number; name: string } | null;
  source: {
    type: "session" | "campaign";
    sessionId: number;
    sessionTitle: string;
    campaignId: number | null;
    campaignName: string | null;
  };
}

export interface PastGenerationsPage {
  items: PastGeneration[];
  nextCursor: string | null;
}

export function usePastGenerations(options: { includeFailed?: boolean; limit?: number } = {}) {
  const { includeFailed = false, limit = 30 } = options;
  return useInfiniteQuery({
    queryKey: ["image-generation", "all", { includeFailed, limit }] as const,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (includeFailed) params.set("includeFailed", "true");
      if (pageParam) params.set("cursor", pageParam);
      return customFetch<PastGenerationsPage>(`/api/image-generation/all?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
