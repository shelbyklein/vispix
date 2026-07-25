import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";
import type { DuplicatePhoto } from "./generated/api.schemas";

type BackfillPerceptualHashesResult = {
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
};

// Near-duplicate group photos share the generated DuplicatePhoto shape so the
// admin UI can reuse the same photo card as the exact-duplicate section.
export type NearDuplicateGroup = {
  key: string;
  distance: number;
  photos: DuplicatePhoto[];
};

type NearDuplicatePhotoGroupsResult = {
  threshold: number;
  totalGroups: number;
  hasMore: boolean;
  groups: NearDuplicateGroup[];
};

export type NearDuplicatePhotoGroupsParams = {
  threshold: number;
  limit?: number;
  offset?: number;
};

const PERCEPTUAL_HASH_BACKFILL_STATUS_KEY = ["admin", "photos", "perceptual-hash-backfill-status"] as const;

export function getNearDuplicatePhotoGroupsQueryKey(params: NearDuplicatePhotoGroupsParams) {
  return ["admin", "photos", "near-duplicates", params.threshold, params.limit ?? null, params.offset ?? null] as const;
}

export function usePerceptualHashBackfillStatus() {
  return useQuery({
    queryKey: PERCEPTUAL_HASH_BACKFILL_STATUS_KEY,
    queryFn: () =>
      customFetch<{ missingCount: number }>("/api/admin/photos/perceptual-hash-backfill-status"),
  });
}

export function useBackfillPerceptualHashes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      customFetch<BackfillPerceptualHashesResult>("/api/admin/photos/perceptual-hash-backfill", {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PERCEPTUAL_HASH_BACKFILL_STATUS_KEY });
    },
  });
}

const NEAR_DUP_INDEX_STATUS_KEY = ["admin", "photos", "near-duplicate-index-status"] as const;

export function getNearDuplicateIndexStatusQueryKey() {
  return NEAR_DUP_INDEX_STATUS_KEY;
}

export function useNearDuplicateIndexStatus() {
  return useQuery({
    queryKey: NEAR_DUP_INDEX_STATUS_KEY,
    queryFn: () =>
      customFetch<{ pairCount: number; hashedPhotos: number }>(
        "/api/admin/photos/near-duplicate-index-status",
      ),
  });
}

export function useRebuildNearDuplicateIndex() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      customFetch<{ photos: number; pairs: number }>("/api/admin/photos/near-duplicate-index/rebuild", {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: NEAR_DUP_INDEX_STATUS_KEY });
      queryClient.invalidateQueries({ queryKey: ["admin", "photos", "near-duplicates"] });
    },
  });
}

export function useNearDuplicatePhotoGroups(params: NearDuplicatePhotoGroupsParams) {
  const search = new URLSearchParams({ threshold: String(params.threshold) });
  if (params.limit != null) search.set("limit", String(params.limit));
  if (params.offset != null) search.set("offset", String(params.offset));
  return useQuery({
    queryKey: getNearDuplicatePhotoGroupsQueryKey(params),
    queryFn: () =>
      customFetch<NearDuplicatePhotoGroupsResult>(
        `/api/admin/photos/near-duplicates?${search.toString()}`,
      ),
  });
}

// The cleanup modal (issues #123/#125) needs full-res image URLs on top of the
// DuplicatePhoto card shape; the near-duplicates route provides imageUrl.
export type NearDuplicateModalPhoto = DuplicatePhoto & { imageUrl: string; perceptualHash: string | null };

const NEAR_DUP_EXTRAS_SUMMARY_KEY = ["admin", "photos", "near-duplicates", "extras-summary"] as const;

// Count of deletable copies across all groups at a sensitivity threshold — drives
// the one-click "delete a match of every group over X% similar" button
// (#177/#179). threshold 0 = only visually-identical (100%) groups.
export function useNearDuplicateExtrasSummary(threshold: number) {
  return useQuery({
    queryKey: [...NEAR_DUP_EXTRAS_SUMMARY_KEY, threshold],
    queryFn: () =>
      customFetch<{ groupCount: number; extraCount: number }>(
        `/api/admin/photos/near-duplicates/extras-summary?threshold=${threshold}`,
      ),
  });
}

// Delete one copy of every group at the given threshold in one shot (keeps
// covers / one per group).
export function useDeleteNearDuplicateExtras() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (threshold: number) =>
      customFetch<{ deleted: number }>(
        `/api/admin/photos/near-duplicates/delete-extras?threshold=${threshold}`,
        { method: "POST" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "photos", "near-duplicates"] });
      queryClient.invalidateQueries({ queryKey: NEAR_DUP_EXTRAS_SUMMARY_KEY });
      queryClient.invalidateQueries({ queryKey: NEAR_DUP_INDEX_STATUS_KEY });
    },
  });
}

// Dismiss a comparison as not-duplicates (issue #124): every pair among the
// given photos is persisted as ignored and the group stops resurfacing.
export function useIgnoreNearDuplicates() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (photoIds: number[]) =>
      customFetch<{ ignoredPairs: number }>("/api/admin/photos/near-duplicates/ignore", {
        method: "POST",
        body: JSON.stringify({ photoIds }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "photos", "near-duplicates"] });
    },
  });
}
