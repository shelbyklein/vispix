import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, customFetch } from "./custom-fetch";
import { getGenerationSessionQueryKey, type ImageGenerationResult, type RequiredInput } from "./create";

// Campaigns (#192): text briefs that drive AI ad suggestions. Suggestions live
// in the campaign's generation session — fetch them with useGenerationSession.

export interface CampaignSummary {
  id: number;
  name: string;
  brief: string;
  /** Bumped on every brief change (#216); send it back as `expectedRevision`. */
  briefRevision: number;
  sessionId: number | null;
  /** Its creator; with org owners/admins, the only ones who can change it (#218). */
  createdById: number;
  createdAt: string;
  updatedAt: string;
}

const CAMPAIGNS_KEY = ["campaigns"] as const;

/** A 409 from a brief save/generate: another tab changed the brief (#216). */
export interface CampaignBriefConflict {
  error: string;
  brief: string;
  briefRevision: number;
}

export function getCampaignBriefConflict(err: unknown): CampaignBriefConflict | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const data = err.data as Partial<CampaignBriefConflict> & { conflict?: boolean } | null;
  return data?.conflict && typeof data.brief === "string" && typeof data.briefRevision === "number"
    ? { error: data.error ?? err.message, brief: data.brief, briefRevision: data.briefRevision }
    : null;
}

/** Whether a failed request never got an HTTP answer (so it may be retried as-is). */
export function isCampaignRequestUnanswered(err: unknown): boolean {
  return !(err instanceof ApiError);
}

export function getCampaignQueryKey(id: number | undefined) {
  return ["campaigns", id ?? null] as const;
}

export function useCampaigns() {
  return useQuery({
    queryKey: CAMPAIGNS_KEY,
    queryFn: () => customFetch<CampaignSummary[]>("/api/campaigns"),
  });
}

export function useCampaign(id: number | undefined) {
  return useQuery({
    queryKey: getCampaignQueryKey(id),
    queryFn: () => customFetch<CampaignSummary>(`/api/campaigns/${id}`),
    enabled: id != null,
  });
}

export function useCreateCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; brief: string }) =>
      customFetch<CampaignSummary>("/api/campaigns", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CAMPAIGNS_KEY }),
  });
}

export function useUpdateCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; name?: string; brief?: string; expectedRevision?: number }) =>
      customFetch<CampaignSummary>(`/api/campaigns/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: CAMPAIGNS_KEY });
      queryClient.invalidateQueries({ queryKey: getCampaignQueryKey(updated.id) });
    },
  });
}

export function useDeleteCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/campaigns/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CAMPAIGNS_KEY }),
  });
}

export interface GenerateCampaignSuggestionsResult {
  sessionId: number | null;
  generations: ImageGenerationResult[];
  /** #215: a concept whose required inputs are missing is not rendered silently. */
  concepts: { title: string; status?: "generated" | "needs_input"; missing?: RequiredInput[] }[];
  /** The brief (and its revision) the suggestions were generated from. */
  brief: string;
  briefRevision: number;
  /** True when this requestId was already accepted; nothing new was started. */
  duplicate?: boolean;
  /** Things to tell the user about the inputs, e.g. no primary logo (#206). */
  notices?: string[];
}

/**
 * Save the on-screen brief and start generation in one request (#216): the
 * server refuses (409) when `expectedRevision` is stale, and starts nothing new
 * for a `requestId` it already accepted.
 */
export function useGenerateCampaignSuggestions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; brief?: string; expectedRevision?: number; requestId?: string }) =>
      customFetch<GenerateCampaignSuggestionsResult>(`/api/campaigns/${id}/generate`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSettled: (result, _err, { id }) => {
      queryClient.invalidateQueries({ queryKey: CAMPAIGNS_KEY });
      queryClient.invalidateQueries({ queryKey: getCampaignQueryKey(id) });
      if (result?.sessionId != null) {
        queryClient.invalidateQueries({ queryKey: getGenerationSessionQueryKey(result.sessionId) });
      }
    },
  });
}
