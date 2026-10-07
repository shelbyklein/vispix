import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PlatformTheme, PlatformThemeState } from "@workspace/api-zod/theme";
import { customFetch } from "./custom-fetch";

export type { PlatformTheme, PlatformThemeState };

const THEME_KEY = ["platform", "theme"] as const;

/** Saved platform theme + built-in defaults (#253). Superadmin only. */
export function usePlatformTheme(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: THEME_KEY,
    queryFn: () => customFetch<PlatformThemeState>("/api/platform/theme"),
    enabled: opts.enabled ?? true,
  });
}

export function useSavePlatformTheme() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (theme: PlatformTheme) =>
      customFetch<PlatformThemeState>("/api/platform/theme", {
        method: "PUT",
        body: JSON.stringify(theme),
        headers: { "content-type": "application/json" },
      }),
    onSuccess: (state) => qc.setQueryData(THEME_KEY, state),
  });
}

export function useResetPlatformTheme() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => customFetch<PlatformThemeState>("/api/platform/theme", { method: "DELETE" }),
    onSuccess: (state) => qc.setQueryData(THEME_KEY, state),
  });
}
