import { useState, useEffect } from "react";
import { FadeImage } from "@/components/ui/fade-image";
import { PhotoGrid } from "@/components/PhotoGrid";
import { GridZoomControl } from "@/components/GridZoomControl";
import { useGridZoom } from "@/hooks/useGridZoom";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { startPhotoDrag } from "@/lib/photoDrag";
import { useLocation, useSearch } from "wouter";
import type { Photo } from "@workspace/api-client-react";
import {
  useSearchPhotos,
  useSemanticSearchPhotos,
  useListUsers,
  useGetMe,
  getListUsersQueryKey,
  getSearchPhotosQueryKey,
  getSemanticSearchPhotosQueryKey,
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
import { Search, SlidersHorizontal, X, Star, Images, EyeOff, Eye, Sparkles, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 48;

function parseSearch(search: string) {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return {
    q: p.get("q") ?? "",
    mode: p.get("mode") === "semantic" ? "semantic" : "keyword",
    ratingMin: p.get("ratingMin") ?? "",
    ratingMax: p.get("ratingMax") ?? "",
    minQuality: p.get("minQuality") ?? "",
    dateFrom: p.get("dateFrom") ?? "",
    dateTo: p.get("dateTo") ?? "",
    uploaderId: p.get("uploaderId") ?? "",
    exclude: p.get("exclude") ?? "",
  };
}

function buildQs(params: Record<string, string>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) p.set(k, v);
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

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
  const { q, mode, ratingMin, ratingMax, minQuality, dateFrom, dateTo, uploaderId, exclude } = urlParams;
  const isSemantic = mode === "semantic";

  // Exclusion terms (dedicated field) — comma-joined in the URL, applied in both modes.
  const excludeTerms = exclude ? exclude.split(",").map((t) => t.trim()).filter(Boolean) : [];

  const [inputValue, setInputValue] = useState(q);
  const [excludeInput, setExcludeInput] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    setInputValue(q);
  }, [q]);

  const [showHidden, setShowHidden] = useState(false);

  const { data: me } = useGetMe();
  const { data: users } = useListUsers({ query: { enabled: me?.role === "admin", queryKey: getListUsersQueryKey() } });

  const hasActiveFilters =
    !!ratingMin || !!ratingMax || !!minQuality || !!dateFrom || !!dateTo || !!uploaderId;

  // Keyword search paginates (infinite scroll); semantic returns one ranked page.
  const [offset, setOffset] = useState(0);
  const [allKeywordPhotos, setAllKeywordPhotos] = useState<Photo[]>([]);

  const searchParams = {
    q,
    ...(ratingMin && { ratingMin: parseFloat(ratingMin) }),
    ...(ratingMax && { ratingMax: parseFloat(ratingMax) }),
    ...(minQuality && { minQuality: parseFloat(minQuality) }),
    ...(dateFrom && { dateFrom }),
    ...(dateTo && { dateTo }),
    ...(uploaderId && { uploaderId: parseInt(uploaderId, 10) }),
    ...(showHidden && { includeHidden: true }),
    ...(excludeTerms.length && { exclude: excludeTerms }),
    limit: PAGE_SIZE,
    offset,
  };

  // Semantic search ignores most keyword filters + pagination — it ranks by
  // image-embedding similarity to the query, respecting hidden visibility and
  // the AI quality floor (#181).
  const semanticParams = {
    q,
    ...(showHidden && { includeHidden: true }),
    ...(excludeTerms.length && { exclude: excludeTerms }),
    ...(minQuality && { minQuality: parseFloat(minQuality) }),
  };

  const keyword = useSearchPhotos(searchParams, {
    query: { enabled: !!q && !isSemantic, queryKey: getSearchPhotosQueryKey(searchParams) },
  });
  const semantic = useSemanticSearchPhotos(semanticParams, {
    query: { enabled: !!q && isSemantic, queryKey: getSemanticSearchPhotosQueryKey(semanticParams) },
  });

  const keywordPage = keyword.data;
  const [keywordHasMore, setKeywordHasMore] = useState(false);
  // Reset the keyword accumulator when the query / filters / mode change.
  const resetKey = JSON.stringify({ q, ratingMin, ratingMax, minQuality, dateFrom, dateTo, uploaderId, showHidden, isSemantic, exclude });
  useEffect(() => {
    setOffset(0);
    setAllKeywordPhotos([]);
    setKeywordHasMore(false);
  }, [resetKey]);
  // Sticky hasMore (see photos.tsx) so it doesn't flicker false mid-fetch.
  useEffect(() => {
    if (isSemantic || !keywordPage) return;
    setKeywordHasMore(keywordPage.hasMore);
    setAllKeywordPhotos((prev) => {
      if (offset === 0) return keywordPage.photos;
      const byId = new Map(prev.map((p) => [p.id, p]));
      for (const p of keywordPage.photos) byId.set(p.id, p);
      return Array.from(byId.values());
    });
  }, [keywordPage, offset, isSemantic]);

  const photos: Photo[] = isSemantic ? semantic.data ?? [] : allKeywordPhotos;
  const hasMore = isSemantic ? false : keywordHasMore;
  const isFetching = isSemantic ? semantic.isFetching : keyword.isFetching;
  const isInitialLoading = (isSemantic ? semantic.isLoading : keyword.isLoading) && photos.length === 0;
  const sentinelRef = useInfiniteScroll(() => {
    if (!isFetching) setOffset((o) => o + PAGE_SIZE);
  }, hasMore);

  // Open results in the lightbox (like the dashboard) instead of navigating to
  // the detail page, so the user stays in their search results.
  const [selectedPhoto, setSelectedPhoto] = useState<LightboxPhoto | null>(null);
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
      setOffset((o) => o + PAGE_SIZE);
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

  function navigate(next: Partial<ReturnType<typeof parseSearch>>) {
    const merged = { ...urlParams, ...next };
    setLocation(`/search${buildQs(merged)}`, { replace: true });
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
            Search across album titles, AI descriptions, and uploaders.
            {me?.role === "admin" && (
              <button
                type="button"
                onClick={() => setShowHidden((v) => !v)}
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
        >
          <button
            type="button"
            onClick={() => navigate({ mode: "keyword" })}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              !isSemantic ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            data-testid="search-mode-keyword"
          >
            <Search className="h-3.5 w-3.5" />
            Keyword
          </button>
          <button
            type="button"
            onClick={() => navigate({ mode: "semantic" })}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              isSemantic ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            data-testid="search-mode-semantic"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Semantic
          </button>
        </div>

        <form onSubmit={handleSearch} className="flex gap-2" data-testid="search-form">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={isSemantic ? "Describe what you're looking for…" : "Search photos, albums, uploaders..."}
              className="pl-9"
              data-testid="search-input"
            />
          </div>
          <Button type="submit" data-testid="search-submit">
            Search
          </Button>
          {!isSemantic && (
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
          )}
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

        {isSemantic && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="semantic-hint">
            <Sparkles className="h-3 w-3 text-primary" />
            Ranked by visual similarity to your description (needs photos to be embedded in Admin → Image Embeddings).
          </p>
        )}

        {!isSemantic && showFilters && (
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
              Enter a keyword to search across album titles, AI descriptions, and uploader names.
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

        {q && !isInitialLoading && (
          <>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground" data-testid="search-result-count">
                {photos.length}{hasMore ? "+" : ""} result{photos.length !== 1 ? "s" : ""} for &ldquo;{q}&rdquo;
                {hasActiveFilters && " with active filters"}
              </p>
              {photos.length > 0 && <GridZoomControl zoom={zoom} setZoom={setZoom} />}
            </div>

            {photos.length === 0 ? (
              <div
                className="flex flex-col items-center justify-center py-24 text-center rounded-xl border border-border bg-card"
                data-testid="search-no-results"
              >
                <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center mb-4">
                  <Images className="h-6 w-6 text-muted-foreground" />
                </div>
                <h3 className="text-base font-medium text-foreground mb-1">No photos found</h3>
                <p className="text-sm text-muted-foreground max-w-sm">
                  Try a different keyword or adjust your filters.
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
                renderItem={(photo) => (
                  <button
                    key={photo.id}
                    type="button"
                    draggable
                    onDragStart={(e) => startPhotoDrag(e, photo.id)}
                    onClick={() => setSelectedPhoto(photo)}
                    className="block w-full h-full text-left"
                    data-testid="search-result-item"
                    aria-label="Open photo"
                  >
                    <div className={cn(
                      "group relative h-full rounded-lg overflow-hidden border border-border bg-muted cursor-pointer",
                      photo.isHidden && "opacity-60"
                    )}>
                      <FadeImage
                        loading="lazy"
                        src={photo.thumbnailKey ? `/api/storage${photo.thumbnailKey}` : photo.url}
                        alt="Photo"
                        className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex flex-col justify-end p-2.5">
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
                )}
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
              </>
            )}
          </>
        )}
      </div>

      <PhotoLightbox
        photo={selectedPhoto}
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
