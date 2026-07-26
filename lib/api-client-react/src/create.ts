import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

// AI image generation — the Create workspace (#167). Hand-written hooks over
// the /api/image-generation routes (same pattern as organizations.ts).

export type GenerationInputKind = "upload" | "photo" | "asset";
export type GenerationInputRole = "style" | "hero_photo" | "exact_asset";
export type GenerationFormatId = "1:1" | "4:5" | "9:16" | "16:9" | "letter";

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
