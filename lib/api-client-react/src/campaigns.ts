import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";
import { getGenerationSessionQueryKey, type ImageGenerationResult } from "./create";

// Campaigns (#192): text briefs that drive AI ad suggestions. Suggestions live
// in the campaign's generation session — fetch them with useGenerationSession.

export interface CampaignSummary {
  id: number;
  name: string;
  brief: string;
  sessionId: number | null;
  createdAt: string;
  updatedAt: string;
}

const CAMPAIGNS_KEY = ["campaigns"] as const;

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
    mutationFn: ({ id, ...body }: { id: number; name?: string; brief?: string }) =>
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

export function useGenerateCampaignSuggestions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch<{ sessionId: number; generations: ImageGenerationResult[]; concepts: { title: string }[] }>(
        `/api/campaigns/${id}/generate`,
        { method: "POST" },
      ),
    onSuccess: (result, id) => {
      queryClient.invalidateQueries({ queryKey: CAMPAIGNS_KEY });
      queryClient.invalidateQueries({ queryKey: getCampaignQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: getGenerationSessionQueryKey(result.sessionId) });
    },
  });
}
