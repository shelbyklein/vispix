import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SavedPalette, SavedPaletteInput } from "@workspace/api-zod/palette";
import { customFetch } from "./custom-fetch";

export type { SavedPalette, SavedPaletteInput };

const PALETTES_KEY = ["platform", "palettes"] as const;
const json = { "content-type": "application/json" };

/** Saved color palettes (#257). Superadmin only. */
export function usePalettes(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: PALETTES_KEY,
    queryFn: () => customFetch<SavedPalette[]>("/api/platform/palettes"),
    enabled: opts.enabled ?? true,
  });
}

export function useCreatePalette() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SavedPaletteInput) =>
      customFetch<SavedPalette>("/api/platform/palettes", { method: "POST", body: JSON.stringify(input), headers: json }),
    onSuccess: () => qc.invalidateQueries({ queryKey: PALETTES_KEY }),
  });
}

export function useUpdatePalette() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: SavedPaletteInput }) =>
      customFetch<SavedPalette>(`/api/platform/palettes/${id}`, { method: "PUT", body: JSON.stringify(input), headers: json }),
    onSuccess: () => qc.invalidateQueries({ queryKey: PALETTES_KEY }),
  });
}

export function useDeletePalette() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/platform/palettes/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: PALETTES_KEY }),
  });
}
