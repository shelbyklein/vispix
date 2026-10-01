import { useState, useEffect, useMemo, useRef } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { FadeImage } from "@/components/ui/fade-image";
import { PhotoGrid } from "@/components/PhotoGrid";
import { GridZoomControl } from "@/components/GridZoomControl";
import { useGridZoom } from "@/hooks/useGridZoom";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { startPhotoDrag } from "@/lib/photoDrag";
import { Link, useLocation, useSearch } from "wouter";
import type { Photo, PhotoRetrievalMatch, PhotoRetrievalResponse, RetrievePhotosParams } from "@workspace/api-client-react";
import {
  ApiError,
  retrievePhotos,
  useListUsers,
  useGetMe,
  getListUsersQueryKey,
  getRetrievePhotosQueryKey,
} from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PhotoLightbox, type LightboxPhoto } from "@/components/PhotoLightbox";
import { Search, SlidersHorizontal, X, Star, Images, EyeOff, Eye, Sparkles, Loader2, AlertTriangle, RotateCw, Info, Orbit } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCapabilities } from "@/hooks/useCapabilities";

const PAGE_SIZE = 48;

function parseSearch(search: string) {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return {
    q: p.get("q") ?? "",
    // "All matches" (combined) is the default; mode=keyword is "Exact words".
    // Older mode=semantic links open the default.
    mode: p.get("mode") === "keyword" ? "keyword" : "",
    ratingMin: p.get("ratingMin") ?? "",
    ratingMax: p.get("ratingMax") ?? "",
    minQuality: p.get("minQuality") ?? "",
    dateFrom: p.get("dateFrom") ?? "",
    dateTo: p.get("dateTo") ?? "",
    uploaderId: p.get("uploaderId") ?? "",
    exclude: p.get("exclude") ?? "",
    hidden: p.get("hidden") === "1" ? "1" : "",
  };
}

// Client-side check mirroring the server's (#205): an inverted date range is
// shown as an error instead of being sent (the server would answer 400).
function filterError(dateFrom: string, dateTo: string): string | null {
  if (dateFrom && dateTo && dateFrom > dateTo) return "“Date from” must be on or before “Date to”.";
  return null;
}

function buildQs(params: Record<string, string>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) p.set(k, v);
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

// Degraded / unavailable reasons from the retrieval contract, in plain words.
const REASON_TEXT: Record<string, string> = {
  not_configured: "the AI search service isn't set up",
  timeout: "the AI search service timed out",
  cancelled: "the request was cancelled",
  provider_error: "the AI search service failed",
};

/** Why a result is here, without presenting similarity as confidence (#208). */
function matchLabel(match: PhotoRetrievalMatch | undefined): { text: string; exact: boolean } | null {
  if (!match) return null;
  if (match.type === "exact") {
    return { text: match.fields?.includes("photo_id") ? "Photo ID match" : "Filename match", exact: true };
  }
  if (match.type === "keyword") {
    const names: Record<string, string> = { album_title: "album", uploader: "uploader", description: "description", filename: "filename" };
    const fields = (match.fields ?? []).map((f) => names[f] ?? f);
    return { text: fields.length ? `Matches ${fields.join(", ")}` : "Keyword match", exact: false };
  }
  return { text: "Similar content", exact: false };
}

const isApiError = (err: unknown): err is ApiError<{ code?: string; error?: string }> => err instanceof ApiError;

function StarRatingFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex gap-1 flex-wrap">
      {["", "1", "2", "3", "4"].map((v) => {
        const label = v ? `${v}+` : "Any";
        const isActive = value === v;
        return (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            className={cn(
              "flex items-center gap-0.5 px-2 py-1 rounded text-xs font-medium border transition-colors",
              isActive
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
            )}
          >
            {v && <Star className="h-3 w-3 fill-current" />}
            {label}
          </button>
        );
      })}
    </div>
  );
}

export default function SearchPage() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();

  const urlParams = parseSearch(searchString);
  const { q, mode, ratingMin, ratingMax, minQuality, dateFrom, dateTo, uploaderId, exclude, hidden } = urlParams;
  const isLiteral = mode === "keyword";
  const invalidFilters = filterError(dateFrom, dateTo);

  // Exclusion terms (dedicated field) — comma-joined in the URL, applied in both modes.
  const excludeTerms = exclude ? exclude.split(",").map((t) => t.trim()).filter(Boolean) : [];

  const [inputValue, setInputValue] = useState(q);
  const [excludeInput, setExcludeInput] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    setInputValue(q);
  }, [q]);

  const { data: me } = useGetMe();

  const caps = useCapabilities();
  // In the URL (#205) so mode switches and Back/Forward keep it; admin-only.
  const showHidden = hidden === "1" && caps.canSeeHidden;
  const { data: users } = useListUsers({ query: { enabled: me?.role === "admin", queryKey: getListUsersQueryKey() } });

  const hasActiveFilters =
    !!ratingMin || !!ratingMax || !!minQuality || !!dateFrom || !!dateTo || !!uploaderId;

  // One shared retrieval contract (#209): pages come through the cursor, each
  // query + filter set is its own cached query, and superseded requests are
  // aborted — a late response can't land in the current results.
  const params: RetrievePhotosParams = {
    q,
    mode: isLiteral ? "keyword" : "combined",
    limit: PAGE_SIZE,
    ...(ratingMin && { ratingMin: parseFloat(ratingMin) }),
    ...(ratingMax && { ratingMax: parseFloat(ratingMax) }),
    ...(minQuality && { minQuality: parseFloat(minQuality) }),
    ...(dateFrom && { dateFrom }),
    ...(dateTo && { dateTo }),
    ...(uploaderId && { uploaderId: parseInt(uploaderId, 10) }),
    ...(showHidden && { includeHidden: true }),
    ...(excludeTerms.length && { exclude: excludeTerms }),
  };
  const queryKey = [...getRetrievePhotosQueryKey(params), "pages"];
  const queryClient = useQueryClient();
  const results = useInfiniteQuery({
    queryKey,
    enabled: !!q && !invalidFilters,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => retrievePhotos({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    getNextPageParam: (last: PhotoRetrievalResponse) => last.page.nextCursor ?? undefined,
    // Client errors (bad filters, stale cursor) won't fix themselves.
    retry: (count, err) => !(isApiError(err) && err.status < 500) && count < 1,
  });
  const { data, error, isLoading, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, isFetchNextPageError, refetch } = results;

  // A stale cursor means the ordering changed underneath us: restart once.
  const restartedFor = useRef<string | null>(null);
  const keyText = JSON.stringify(queryKey);
  useEffect(() => {
    if (isApiError(error) && error.data?.code === "cursor_mismatch" && restartedFor.current !== keyText) {
      restartedFor.current = keyText;
      void queryClient.resetQueries({ queryKey });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error, keyText]);

  const firstPage = data?.pages[0];
  const lastPage = data?.pages[data.pages.length - 1];
  const items = useMemo(() => {
    const seen = new Set<number>();
    const out: { photo: Photo; match: PhotoRetrievalMatch }[] = [];
    for (const page of data?.pages ?? []) {
      for (const item of page.items) {
        if (seen.has(item.photo.id)) continue;
        seen.add(item.photo.id);
        out.push(item);
      }
    }
    return out;
  }, [data]);
  const photos: Photo[] = useMemo(() => items.map((i) => i.photo), [items]);
  const matchById = useMemo(() => new Map(items.map((i) => [i.photo.id, i.match])), [items]);

  const unavailable = firstPage?.status === "unavailable";
  const degraded = firstPage?.degraded ?? lastPage?.degraded ?? null;
  const nextPageUnavailable = !!data && data.pages.length > 1 && lastPage?.status === "unavailable";
  const firstPageError = !data && error && !(isApiError(error) && error.data?.code === "cursor_mismatch") ? (error as Error) : null;
  const nextPageError = isFetchNextPageError || nextPageUnavailable;
  const hasMore = !!hasNextPage && !nextPageError;
  const total = firstPage?.total ?? null;
  const limited = !!lastPage?.page.limited;
  const exhausted = !!lastPage?.page.exhausted;
  const notEmbedded = firstPage?.coverage?.notEmbedded ?? 0;
  const isInitialLoading = isLoading && photos.length === 0;
  const sentinelRef = useInfiniteScroll(() => {
    if (!isFetching) void fetchNextPage();
  }, hasMore);

  // Coming back from a photo's details page (#210): return to that photo.
  const FOCUS_KEY = "vispix:search-focus";
  useEffect(() => {
    if (!photos.length) return;
    let focus: { search: string; id: number } | null = null;
    try {
      focus = JSON.parse(sessionStorage.getItem(FOCUS_KEY) ?? "null");
    } catch {
      /* storage unavailable */
    }
    if (!focus || focus.search !== searchString) return;
    const el = document.querySelector(`[data-testid="search-result-item"][data-photo-id="${focus.id}"]`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      try {
        sessionStorage.removeItem(FOCUS_KEY);
      } catch {
        /* ignore */
      }
    }
  }, [photos.length, searchString]);

  // Open results in the lightbox (like the dashboard) instead of navigating to
  // the detail page, so the user stays in their search results.
  const [selectedPhoto, setSelectedPhoto] = useState<LightboxPhoto | null>(null);
  useEffect(() => {
    if (!selectedPhoto) return;
    try {
      sessionStorage.setItem("vispix:search-focus", JSON.stringify({ search: searchString, id: selectedPhoto.id }));
    } catch {
      /* storage unavailable */
    }
  }, [selectedPhoto, searchString]);
  const { zoom, setZoom } = useGridZoom();
  const [pendingAdvance, setPendingAdvance] = useState(false);
  const selectedIndex = selectedPhoto ? photos.findIndex((p) => p.id === selectedPhoto.id) : -1;
  const hasPrev = selectedIndex > 0;
  const hasNext = selectedIndex >= 0 && (selectedIndex < photos.length - 1 || hasMore);
  function handlePrev() {
    if (hasPrev) setSelectedPhoto(photos[selectedIndex - 1]);
  }
  function handleNext() {
    const nextIdx = selectedIndex + 1;
    if (nextIdx < photos.length) setSelectedPhoto(photos[nextIdx]);
    else if (hasMore) {
      setPendingAdvance(true);
      void fetchNextPage();
    }
  }
  useEffect(() => {
    if (!pendingAdvance || !selectedPhoto) return;
    const idx = photos.findIndex((p) => p.id === selectedPhoto.id);
    if (idx >= 0 && idx < photos.length - 1) {
      setSelectedPhoto(photos[idx + 1]);
      setPendingAdvance(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos, pendingAdvance]);

  // Each search / mode / filter change is its own history entry (#205), so
  // Back and Forward step through earlier searches with their filters intact.
  function navigate(next: Partial<ReturnType<typeof parseSearch>>) {
    const merged = { ...urlParams, ...next };
    const target = `/search${buildQs(merged)}`;
    if (target !== `/search${buildQs(urlParams)}`) setLocation(target);
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    navigate({ q: inputValue.trim() });
  }

  function addExclude(term: string) {
    const t = term.trim();
    if (!t || excludeTerms.includes(t)) {
      setExcludeInput("");
      return;
    }
    navigate({ exclude: [...excludeTerms, t].join(",") });
    setExcludeInput("");
  }

  function removeExclude(term: string) {
    navigate({ exclude: excludeTerms.filter((x) => x !== term).join(",") });
  }

  function handleFilterChange(field: string, value: string) {
    navigate({ [field]: value });
  }

  function clearFilters() {
    navigate({
      ratingMin: "",
      ratingMax: "",
      minQuality: "",
      dateFrom: "",
      dateTo: "",
      uploaderId: "",
    });
  }

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="search-page">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Search Photos</h1>
          <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
            Describe what you're looking for, or enter a filename or photo ID.
            {caps.canSeeHidden && (
              <button
                type="button"
                onClick={() => navigate({ hidden: showHidden ? "" : "1" })}
                className={`flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium transition-colors ${showHidden ? "bg-primary/10 text-primary" : "hover:bg-muted text-muted-foreground/70 hover:text-muted-foreground"}`}
                data-testid="toggle-hidden-photos"
                title={showHidden ? "Hide hidden photos" : "Show hidden photos"}
              >
                {showHidden ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                {showHidden ? "hide hidden" : "show hidden"}
              </button>
            )}
          </div>
        </div>

        <div
          className="flex w-fit items-center gap-0.5 rounded-lg border border-border p-0.5"
          data-testid="search-mode-toggle"
          role="group"
          aria-label="Search mode"
        >
          <button
            type="button"
            onClick={() => navigate({ mode: "" })}
            aria-pressed={!isLiteral}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              !isLiteral ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            data-testid="search-mode-combined"
            title="Photo IDs and filenames exactly, then photos that match your description"
          >
            <Sparkles className="h-3.5 w-3.5" />
            All matches
          </button>
          <button
            type="button"
            onClick={() => navigate({ mode: "keyword" })}
            aria-pressed={isLiteral}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              isLiteral ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            data-testid="search-mode-keyword"
            title="Only the exact words, in album titles, descriptions, uploaders and filenames"
          >
            <Search className="h-3.5 w-3.5" />
            Exact words
          </button>
        </div>

        <form onSubmit={handleSearch} className="flex gap-2" data-testid="search-form">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={isLiteral ? "Words in albums, descriptions, uploaders or filenames…" : "Describe a photo, or enter a filename or photo ID…"}
              className="pl-9"
              data-testid="search-input"
            />
          </div>
          <Button type="submit" data-testid="search-submit">
            Search
          </Button>
          <Button
            type="button"
            variant="outline"
            className={cn("gap-1.5", hasActiveFilters && "border-primary text-primary")}
            onClick={() => setShowFilters((v) => !v)}
            data-testid="toggle-filters"
          >
            <SlidersHorizontal className="h-4 w-4" />
            Filters
            {hasActiveFilters && (
              <span className="ml-1 h-4 w-4 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center font-medium">
                {[ratingMin, ratingMax, minQuality, dateFrom, dateTo, uploaderId].filter(Boolean).length}
              </span>
            )}
          </Button>
        </form>

        {q && (
          <div className="flex flex-wrap items-center gap-2" data-testid="exclude-bar">
            <span className="text-xs font-medium text-muted-foreground">Exclude:</span>
            {excludeTerms.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive"
                data-testid="exclude-chip"
              >
                {t}
                <button
                  type="button"
                  onClick={() => removeExclude(t)}
                  aria-label={`Remove exclusion ${t}`}
                  data-testid={`remove-exclude-${t}`}
                  className="ml-0.5 rounded-full hover:opacity-70"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                addExclude(excludeInput);
              }}
              className="inline-flex items-center gap-1"
            >
              <Input
                value={excludeInput}
                onChange={(e) => setExcludeInput(e.target.value)}
                placeholder="add a term to exclude…"
                className="h-7 w-48 text-xs"
                data-testid="exclude-input"
              />
              <Button type="submit" size="sm" variant="outline" className="h-7 text-xs" disabled={!excludeInput.trim()} data-testid="add-exclude-btn">
                Exclude
              </Button>
            </form>
          </div>
        )}

        {!isLiteral && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="combined-hint">
            <Sparkles className="h-3 w-3 text-primary" />
            Exact photo IDs and filenames first, then photos whose content matches your description.
            {hasActiveFilters && " Your filters apply to both."}
          </p>
        )}
        {!isLiteral && excludeTerms.length > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="semantic-exclude-note">
            Here, exclusions push results away from those concepts — matching photos can still appear.
            Switch to Exact words to remove them outright.
          </p>
        )}

        {invalidFilters && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert" data-testid="filter-error">
            {invalidFilters} Fix the dates to search.
          </p>
        )}

        {showFilters && (
          <div
            className="rounded-xl border border-border bg-card p-5 space-y-4"
            data-testid="filter-panel"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">Filters</h2>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors"
                  data-testid="clear-filters"
                >
                  <X className="h-3 w-3" />
                  Clear all
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Minimum rating
                </label>
                <StarRatingFilter
                  value={ratingMin}
                  onChange={(v) => handleFilterChange("ratingMin", v)}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Maximum rating
                </label>
                <StarRatingFilter
                  value={ratingMax}
                  onChange={(v) => handleFilterChange("ratingMax", v)}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Min AI quality
                </label>
                <Select
                  value={minQuality || "__any__"}
                  onValueChange={(v) => handleFilterChange("minQuality", v === "__any__" ? "" : v)}
                >
                  <SelectTrigger className="h-9 text-sm" data-testid="filter-min-quality">
                    <SelectValue placeholder="Any quality" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__any__">Any quality</SelectItem>
                    <SelectItem value="5">5+ — usable</SelectItem>
                    <SelectItem value="6">6+ — decent</SelectItem>
                    <SelectItem value="7">7+ — good</SelectItem>
                    <SelectItem value="8">8+ — great</SelectItem>
                    <SelectItem value="9">9+ — exceptional</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Date from
                </label>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => handleFilterChange("dateFrom", e.target.value)}
                  className="h-9 text-sm"
                  data-testid="filter-date-from"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Date to
                </label>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => handleFilterChange("dateTo", e.target.value)}
                  className="h-9 text-sm"
                  data-testid="filter-date-to"
                />
              </div>

              {me?.role === "admin" && users && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Uploader
                  </label>
                  <Select
                    value={uploaderId || "__all__"}
                    onValueChange={(v) =>
                      handleFilterChange("uploaderId", v === "__all__" ? "" : v)
                    }
                  >
                    <SelectTrigger className="h-9 text-sm" data-testid="filter-uploader">
                      <SelectValue placeholder="Any uploader" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">Any uploader</SelectItem>
                      {users.map((u) => (
                        <SelectItem key={u.id} value={String(u.id)}>
                          {u.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {hasActiveFilters && (
              <div className="flex flex-wrap gap-1.5 pt-2 border-t border-border">
                {ratingMin && (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    Min rating: {ratingMin}+
                    <button
                      type="button"
                      onClick={() => handleFilterChange("ratingMin", "")}
                      className="ml-1 hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )}
                {minQuality && (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    AI quality: {minQuality}+
                    <button
                      type="button"
                      onClick={() => handleFilterChange("minQuality", "")}
                      className="ml-1 hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )}
                {ratingMax && (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    Max rating: {ratingMax}
                    <button
                      type="button"
                      onClick={() => handleFilterChange("ratingMax", "")}
                      className="ml-1 hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )}
                {dateFrom && (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    From: {dateFrom}
                    <button
                      type="button"
                      onClick={() => handleFilterChange("dateFrom", "")}
                      className="ml-1 hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )}
                {dateTo && (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    To: {dateTo}
                    <button
                      type="button"
                      onClick={() => handleFilterChange("dateTo", "")}
                      className="ml-1 hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )}
                {uploaderId && (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    Uploader:{" "}
                    {users?.find((u) => String(u.id) === uploaderId)?.name ?? uploaderId}
                    <button
                      type="button"
                      onClick={() => handleFilterChange("uploaderId", "")}
                      className="ml-1 hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )}
              </div>
            )}
          </div>
        )}

        {!q && (
          <div
            className="flex flex-col items-center justify-center py-24 text-center rounded-xl border border-border bg-card"
            data-testid="search-empty-state"
          >
            <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center mb-4">
              <Search className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="text-base font-medium text-foreground mb-1">
              Search your photo library
            </h3>
            <p className="text-sm text-muted-foreground max-w-sm">
              Describe a scene (&ldquo;archers at full draw&rdquo;), or paste a filename or photo ID to find it exactly.
            </p>
          </div>
        )}

        {q && isInitialLoading && (
          <div
            className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3"
            data-testid="search-loading"
          >
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="aspect-square rounded-lg" />
            ))}
          </div>
        )}

        {q && !invalidFilters && firstPageError && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert" data-testid="search-error">
            <span>Search failed: {isApiError(firstPageError) ? firstPageError.data?.error ?? firstPageError.message : firstPageError.message}</span>
            <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => void refetch()} data-testid="search-retry">
              <RotateCw className="h-3 w-3" /> Retry
            </Button>
          </div>
        )}

        {q && !invalidFilters && unavailable && (
          <div
            className="flex flex-col items-center justify-center py-16 text-center rounded-xl border border-amber-500/40 bg-amber-500/5"
            role="alert"
            data-testid="search-unavailable"
          >
            <AlertTriangle className="h-6 w-6 text-amber-600 mb-3" />
            <h3 className="text-base font-medium text-foreground mb-1">Search is unavailable right now</h3>
            <p className="text-sm text-muted-foreground max-w-sm">
              Nothing was searched because {REASON_TEXT[firstPage?.degraded?.reason ?? "provider_error"]}. This isn&rsquo;t an empty result.
            </p>
            <div className="mt-4 flex gap-2">
              <Button size="sm" variant="outline" className="gap-1" onClick={() => void refetch()} data-testid="search-unavailable-retry">
                <RotateCw className="h-3.5 w-3.5" /> Retry
              </Button>
              {!isLiteral && (
                <Button size="sm" variant="ghost" onClick={() => navigate({ mode: "keyword" })}>
                  Search exact words instead
                </Button>
              )}
            </div>
          </div>
        )}

        {q && !isInitialLoading && !invalidFilters && !firstPageError && !unavailable && data && (
          <>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground" data-testid="search-result-count">
                {photos.length === 0
                  ? degraded?.affects === "concept"
                    ? `No exact or keyword matches for “${q}”`
                    : `No results for “${q}”`
                  : exhausted
                    ? `${photos.length === 1 ? "1 result" : `All ${photos.length} results`} for “${q}”`
                    : limited
                      ? `Top ${photos.length} results for “${q}” — refine your search to see others`
                      : `Showing ${photos.length}${total != null ? ` of ${total.toLocaleString()}` : ""} results for “${q}”`}
                {hasActiveFilters && " with active filters"}
              </p>
              {photos.length > 0 && <GridZoomControl zoom={zoom} setZoom={setZoom} />}
            </div>

            {degraded?.affects === "concept" && photos.length > 0 && (
              <p className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-foreground" role="status" data-testid="search-degraded-concept">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                Matching by content is unavailable because {REASON_TEXT[degraded.reason]} — showing exact and keyword matches only.
                <button type="button" className="ml-1 underline" onClick={() => void refetch()}>Retry</button>
              </p>
            )}
            {degraded?.affects === "exclusions" && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status" data-testid="search-degraded-exclusions">
                <Info className="h-3.5 w-3.5 shrink-0" />
                Your exclusions couldn&rsquo;t be applied because {REASON_TEXT[degraded.reason]}.
              </p>
            )}
            {!isLiteral && notEmbedded > 0 && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="search-coverage">
                <Info className="h-3.5 w-3.5 shrink-0" />
                {notEmbedded.toLocaleString()} matching photo{notEmbedded === 1 ? " isn't" : "s aren't"} indexed for content search yet, so {notEmbedded === 1 ? "it" : "they"} can only be found by exact words.
              </p>
            )}

            {photos.length === 0 && degraded?.affects === "concept" ? (
              // Content matching didn't run, so this is not a genuine empty result.
              <div
                className="flex flex-col items-center justify-center py-16 text-center rounded-xl border border-amber-500/40 bg-amber-500/5"
                role="alert"
                data-testid="search-unavailable"
              >
                <AlertTriangle className="h-6 w-6 text-amber-600 mb-3" />
                <h3 className="text-base font-medium text-foreground mb-1">Matching by content is unavailable right now</h3>
                <p className="text-sm text-muted-foreground max-w-sm">
                  Nothing matched exactly, and {REASON_TEXT[degraded.reason]}, so photos that match your description couldn&rsquo;t be looked up.
                </p>
                <Button size="sm" variant="outline" className="mt-4 gap-1" onClick={() => void refetch()} data-testid="search-unavailable-retry">
                  <RotateCw className="h-3.5 w-3.5" /> Retry
                </Button>
              </div>
            ) : photos.length === 0 ? (
              <div
                className="flex flex-col items-center justify-center py-24 text-center rounded-xl border border-border bg-card"
                data-testid="search-no-results"
              >
                <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center mb-4">
                  <Images className="h-6 w-6 text-muted-foreground" />
                </div>
                <h3 className="text-base font-medium text-foreground mb-1">No photos found</h3>
                <p className="text-sm text-muted-foreground max-w-sm">
                  Try different words or adjust your filters.
                </p>
                {hasActiveFilters && (
                  <Button variant="outline" size="sm" className="mt-4" onClick={clearFilters}>
                    Clear filters
                  </Button>
                )}
              </div>
            ) : (
              <>
              <PhotoGrid
                items={photos}
                getKey={(photo) => photo.id}
                densityOverride={zoom}
                data-testid="search-results"
                renderItem={(photo) => {
                  const label = matchLabel(matchById.get(photo.id));
                  return (
                  <div key={photo.id} className="group/tile relative h-full">
                  <button
                    type="button"
                    draggable
                    onDragStart={(e) => startPhotoDrag(e, photo.id)}
                    onClick={() => setSelectedPhoto(photo)}
                    className="block w-full h-full text-left"
                    data-testid="search-result-item"
                    data-photo-id={photo.id}
                    aria-label={`Open photo ${photo.filename ?? photo.id}${label ? ` — ${label.text}` : ""}`}
                  >
                    <div className={cn(
                      "group relative h-full rounded-lg overflow-hidden border border-border bg-muted cursor-pointer",
                      photo.isHidden && "opacity-60",
                      label?.exact && "ring-2 ring-primary",
                    )}>
                      <FadeImage
                        loading="lazy"
                        src={photo.thumbnailKey ? `/api/storage${photo.thumbnailKey}` : photo.url}
                        alt={photo.filename ?? "Photo"}
                        className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
                      />
                      {label?.exact && (
                        <span className="absolute top-1.5 right-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground" data-testid="exact-match-badge">
                          {label.text}
                        </span>
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex flex-col justify-end p-2.5">
                        {label && !label.exact && (
                          <p className="text-[10px] text-white/70" data-testid="match-reason">{label.text}</p>
                        )}
                        {photo.albumTitle && (
                          <p className="text-xs text-white/80 font-medium truncate">
                            {photo.albumTitle}
                          </p>
                        )}
                        {photo.averageRating != null && (
                          <div className="flex items-center gap-0.5 mt-1">
                            <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                            <span className="text-xs text-white font-medium">
                              {photo.averageRating.toFixed(1)}
                            </span>
                          </div>
                        )}
                      </div>
                      {photo.isHidden && (
                        <div
                          className="absolute top-1.5 left-1.5 flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5"
                          title="Hidden photo"
                          data-testid="hidden-badge"
                        >
                          <EyeOff className="h-2.5 w-2.5 text-white" />
                          <span className="text-[10px] font-semibold text-white leading-none">Hidden</span>
                        </div>
                      )}
                    </div>
                  </button>
                  <Link
                    href={`/photos/${photo.id}/graph?from=${encodeURIComponent(`/search${searchString ? `?${searchString}` : ""}`)}`}
                    className="absolute bottom-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity group-hover/tile:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    aria-label={`Explore connections from photo ${photo.filename ?? photo.id}`}
                    title="Explore connections"
                    data-testid="search-explore-connections"
                  >
                    <Orbit className="h-3.5 w-3.5" />
                  </Link>
                  </div>
                  );
                }}
              />
              {hasMore && (
                <div
                  ref={sentinelRef}
                  className="flex items-center justify-center py-8 text-sm text-muted-foreground"
                  data-testid="search-load-more"
                >
                  <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading more…
                </div>
              )}
              {nextPageError && (
                <div className="flex items-center justify-center gap-3 py-6 text-sm text-destructive" role="alert" data-testid="search-next-page-error">
                  Couldn&rsquo;t load more results.
                  <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage} data-testid="search-next-page-retry">
                    <RotateCw className="h-3 w-3" /> Retry
                  </Button>
                </div>
              )}
              </>
            )}
          </>
        )}
      </div>

      <PhotoLightbox
        photo={selectedPhoto}
        detailsQuery={searchString.replace(/^\?/, "")}
        onClose={() => setSelectedPhoto(null)}
        hasPrev={hasPrev}
        hasNext={hasNext}
        onPrev={handlePrev}
        onNext={handleNext}
        advanceOnRate={false}
      />
    </AppLayout>
  );
}
