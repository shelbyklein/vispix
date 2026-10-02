import { useQuery } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

export type AdminHubStatus = {
  aiAnalysisPending: number;
  embeddingsPending: number;
  thumbnailsMissing: number;
  capturedDatesMissing: number;
  duplicateGroups: number;
};

/** At-a-glance counts for the admin hub cards (one aggregated cheap call). */
export function useAdminHubStatus(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["admin", "hub-status"],
    queryFn: () => customFetch<AdminHubStatus>("/api/admin/hub-status"),
    enabled: opts.enabled ?? true,
  });
}

export type HealthState = "not_configured" | "configured" | "working" | "failing" | "stale";

export type ServiceHealth = {
  state: HealthState;
  detail: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureReason: { code: string; message: string } | null;
};

/** Dashboard library health (#217): service state + coverage + duplicate counts, org-scoped. */
export type LibraryHealth = {
  generatedAt: string;
  staleAfterDays: number;
  imageAnalysis: ServiceHealth & {
    provider: string | null;
    lastUsedProvider: string | null;
    coverage: { total: number; analysed: number; failed: number; pending: number };
  };
  imageEmbeddings: ServiceHealth & {
    coverage: { total: number; embedded: number; missing: number; refreshPending: number };
  };
  searchEmbedding: ServiceHealth;
  duplicates: {
    exact: { groups: number; extraCopies: number; hashedPhotos: number; totalPhotos: number };
    near: { groups: number; photos: number; threshold: number; indexedPhotos: number; totalPhotos: number };
  };
};

export function useLibraryHealth(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["admin", "library-health"],
    queryFn: () => customFetch<LibraryHealth>("/api/admin/library-health"),
    enabled: opts.enabled ?? true,
    staleTime: 60 * 1000,
  });
}
