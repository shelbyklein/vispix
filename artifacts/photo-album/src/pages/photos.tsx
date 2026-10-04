import { SelectionRightsSummary } from "@/components/usage-rights/UsageRights";
import { useState, useEffect } from "react";
import { FadeImage } from "@/components/ui/fade-image";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import type { LightboxPhoto } from "@/components/PhotoLightbox";
import { PhotoGrid } from "@/components/PhotoGrid";
import { GridZoomControl } from "@/components/GridZoomControl";
import { useGridZoom } from "@/hooks/useGridZoom";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { startPhotoDrag } from "@/lib/photoDrag";
import { useLocation, useSearch, Link } from "wouter";
import {
  useListPhotos,
  useListUsers,
  getListUsersQueryKey,
  useListAlbums,
  useListAttributionTags,
  useGetMe,
  useRerunPhotoAnalysis,
  useBulkDeletePhotos,
  getListPhotosQueryKey,
  getGetRecentPhotosQueryKey,
  getGetTopRatedPhotosQueryKey,
} from "@workspace/api-client-react";
import type { Photo } from "@workspace/api-client-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Camera, Search, SlidersHorizontal, X, Star, ChevronLeft, ChevronRight, Sparkles, EyeOff, Eye, Bot, Check, AlertCircle, FolderOpen, Loader2, Trash2, CheckSquare, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { photoControlLabel } from "@/lib/photo-a11y";
import { useToast } from "@/hooks/use-toast";
import { useCapabilities } from "@/hooks/useCapabilities";

const PAGE_SIZE = 48;

function parseSearch(search: string) {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return {
    search: p.get("search") ?? "",
    ratingMin: p.get("ratingMin") ?? "",
    uploaderId: p.get("uploaderId") ?? "",
    albumId: p.get("albumId") ?? "",
    dateFrom: p.get("dateFrom") ?? "",
    dateTo: p.get("dateTo") ?? "",
    aiStatus: p.get("aiStatus") ?? "",
    attribution: p.get("attribution") ?? "",
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

export default function PhotosPage() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const urlParams = parseSearch(searchString);
  const { search, ratingMin, uploaderId, albumId, dateFrom, dateTo, aiStatus, attribution } = urlParams;
  const [inputValue, setInputValue] = useState(search);
  const [showFilters, setShowFilters] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<LightboxPhoto | null>(null);
  const { toast } = useToast();
  const qc = useQueryClient();
  useEffect(() => {
    setInputValue(search);
  }, [search]);

  const [showHidden, setShowHidden] = useState(false);
  const [reanalyzingIds, setReanalyzingIds] = useState<Set<number>>(new Set());
  const { mutate: rerunAnalysis } = useRerunPhotoAnalysis();
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const { mutate: bulkDelete, isPending: bulkDeleting } = useBulkDeletePhotos();

  function handleRerunAnalysis(photoId: number) {
    setReanalyzingIds((prev) => new Set(prev).add(photoId));
    rerunAnalysis(
      { id: photoId },
      {
        onSuccess: () => {
          toast({ title: "AI analysis started" });
          qc.invalidateQueries({ queryKey: getListPhotosQueryKey() });
        },
        onError: () => toast({ title: "Failed to start AI analysis", variant: "destructive" }),
        onSettled: () =>
          setReanalyzingIds((prev) => {
            const next = new Set(prev);
            next.delete(photoId);
            return next;
          }),
      }
    );
  }

  const { data: me } = useGetMe();

  const caps = useCapabilities();
  const { data: users } = useListUsers({ query: { enabled: me?.role === "admin", queryKey: getListUsersQueryKey() } });
  const { data: albums } = useListAlbums();
  const { data: attributionTagList } = useListAttributionTags();
  const { zoom, setZoom } = useGridZoom();

  const filters = {
    ...(search && { search }),
    ...(ratingMin && { ratingMin: parseFloat(ratingMin) }),
    ...(uploaderId && { uploaderId: parseInt(uploaderId, 10) }),
    ...(albumId && { albumId: parseInt(albumId, 10) }),
    ...(dateFrom && { dateFrom }),
    ...(dateTo && { dateTo }),
    ...(showHidden && { includeHidden: true }),
    ...(aiStatus && { aiStatus: aiStatus as "has_description" | "failed" | "not_analysed" }),
    // "" = no filter; "none" = untagged; otherwise a specific attribution tag id.
    ...(attribution && attribution !== "none" && { attributionTagId: parseInt(attribution, 10) }),
    ...(attribution === "none" && { hasAttribution: false }),
  };

  const hasActiveFilters = !!(ratingMin || uploaderId || albumId || dateFrom || dateTo || aiStatus || attribution);

  // Server-side pagination with an infinite-scroll accumulator (mirrors album-detail).
  const [offset, setOffset] = useState(0);
  const [allPhotos, setAllPhotos] = useState<Photo[]>([]);
  const [pendingAdvance, setPendingAdvance] = useState(false);

  const [hasMore, setHasMore] = useState(false);
  const apiParams = { ...filters, limit: PAGE_SIZE, offset };
  const filterKey = JSON.stringify(filters);

  // Reset to the first page whenever the filters/search change.
  useEffect(() => {
    setOffset(0);
    setAllPhotos([]);
    setHasMore(false);
  }, [filterKey]);

  const { data: photoPage, isLoading, isFetching } = useListPhotos(apiParams, {
    query: { queryKey: getListPhotosQueryKey(apiParams) },
  });

  // Accumulate pages: page 0 replaces, later pages merge-by-id (dedupe). hasMore
  // is sticky state (updated only when a page arrives) so it doesn't flicker to
  // false mid-fetch and tear down the infinite-scroll observer.
  useEffect(() => {
    if (!photoPage) return;
    setHasMore(photoPage.hasMore);
    setAllPhotos((prev) => {
      if (offset === 0) return photoPage.photos;
      const byId = new Map(prev.map((p) => [p.id, p]));
      for (const p of photoPage.photos) byId.set(p.id, p);
      return Array.from(byId.values());
    });
  }, [photoPage, offset]);

  const sentinelRef = useInfiniteScroll(() => {
    if (!isFetching) setOffset((o) => o + PAGE_SIZE);
  }, hasMore);

  const isInitialLoading = isLoading && allPhotos.length === 0;

  const selectedPhotoIndex = selectedPhoto ? allPhotos.findIndex((p) => p.id === selectedPhoto.id) : -1;
  const lightboxHasPrev = selectedPhotoIndex > 0;
  const lightboxHasNext = selectedPhotoIndex >= 0 && (selectedPhotoIndex < allPhotos.length - 1 || hasMore);

  function lightboxPhotoAt(idx: number): LightboxPhoto | null {
    if (idx < 0 || idx >= allPhotos.length) return null;
    const p = allPhotos[idx];
    return { id: p.id, url: p.url, thumbnailKey: p.thumbnailKey, name: p.filename, averageRating: p.averageRating, albumId: p.albumId };
  }

  function handleLightboxPrev() {
    if (lightboxHasPrev) setSelectedPhoto(lightboxPhotoAt(selectedPhotoIndex - 1));
  }

  function handleLightboxNext() {
    const nextIdx = selectedPhotoIndex + 1;
    if (nextIdx < allPhotos.length) {
      setSelectedPhoto(lightboxPhotoAt(nextIdx));
    } else if (hasMore) {
      // Past the last loaded photo — load the next page, then advance once it arrives.
      setPendingAdvance(true);
      setOffset((o) => o + PAGE_SIZE);
    }
  }

  // Advance the lightbox to the newly-loaded photo after a "next past end".
  useEffect(() => {
    if (!pendingAdvance || !selectedPhoto) return;
    const idx = allPhotos.findIndex((p) => p.id === selectedPhoto.id);
    if (idx >= 0 && idx < allPhotos.length - 1) {
      setSelectedPhoto(lightboxPhotoAt(idx + 1));
      setPendingAdvance(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allPhotos, pendingAdvance]);

  function navigate(next: Partial<ReturnType<typeof parseSearch>>) {
    const merged = { ...urlParams, ...next };
    setLocation(`/photos${buildQs(merged)}`, { replace: true });
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    navigate({ search: inputValue.trim() });
  }

  function handleFilterChange(field: string, value: string) {
    navigate({ [field]: value });
  }

  function clearFilters() {
    navigate({
      ratingMin: "",
      uploaderId: "",
      albumId: "",
      dateFrom: "",
      dateTo: "",
      aiStatus: "",
      attribution: "",
    });
  }

  function clearSearch() {
    setInputValue("");
    navigate({ search: "" });
  }

  function toggleSelection(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitSelectMode() {
    setIsSelectMode(false);
    setSelectedIds(new Set());
  }

  function handleBulkDelete() {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    bulkDelete(
      { data: { ids } },
      {
        onSuccess: (result) => {
          toast({ title: `${result.deleted} photo${result.deleted !== 1 ? "s" : ""} deleted` });
          setAllPhotos((prev) => prev.filter((p) => !ids.includes(p.id)));
          qc.invalidateQueries({ queryKey: getListPhotosQueryKey().slice(0, 1) });
          qc.invalidateQueries({ queryKey: getGetRecentPhotosQueryKey() });
          qc.invalidateQueries({ queryKey: getGetTopRatedPhotosQueryKey() });
          exitSelectMode();
        },
        onError: () => toast({ title: "Failed to delete photos", variant: "destructive" }),
      }
    );
    setConfirmBulkDelete(false);
  }

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="photos-page">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">All Photos</h1>
            <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
              {isInitialLoading
                ? "Loading…"
                : `${allPhotos.length.toLocaleString()}${hasMore ? "+" : ""} photo${allPhotos.length !== 1 ? "s" : ""}${hasMore ? " loaded" : ""}`}
              {caps.canSeeHidden && !isInitialLoading && (
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
          <div className="flex items-center gap-2">
            {caps.isOrgManager && (
              <Button
                variant={isSelectMode ? "default" : "outline"}
                size="sm"
                className="gap-1.5"
                onClick={() => isSelectMode ? exitSelectMode() : setIsSelectMode(true)}
                data-testid="toggle-select-mode"
              >
                <CheckSquare className="h-4 w-4" />
                {isSelectMode ? "Cancel" : "Select"}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className={cn("gap-1.5", hasActiveFilters && "border-primary text-primary")}
              onClick={() => setShowFilters((v) => !v)}
              data-testid="toggle-filters"
            >
              <SlidersHorizontal className="h-4 w-4" />
              Filters
              {hasActiveFilters && (
                <span className="ml-1 h-4 w-4 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center font-medium">
                  {[ratingMin, uploaderId, albumId, dateFrom, dateTo, aiStatus, attribution].filter(Boolean).length}
                </span>
              )}
            </Button>
            <GridZoomControl zoom={zoom} setZoom={setZoom} />
          </div>
        </div>

        <form onSubmit={handleSearch} className="flex gap-2" data-testid="search-form">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Search photos by caption, album, uploader…"
              className="pl-9"
              data-testid="search-input"
            />
          </div>
          <Button type="submit" data-testid="search-submit">Search</Button>
          {search && (
            <Button type="button" variant="outline" onClick={clearSearch} data-testid="clear-search">
              <X className="h-4 w-4" />
            </Button>
          )}
        </form>

        {search && (
          <p className="text-sm text-muted-foreground" data-testid="search-query-label">
            Showing results for &ldquo;{search}&rdquo;
            {hasActiveFilters && " with active filters"}
          </p>
        )}

        {showFilters && (
          <div className="rounded-xl border border-border bg-card p-5 space-y-4" data-testid="filter-panel">
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
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Minimum rating</label>
                <StarRatingFilter
                  value={ratingMin}
                  onChange={(v) => handleFilterChange("ratingMin", v)}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Date from</label>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => handleFilterChange("dateFrom", e.target.value)}
                  className="h-9 text-sm"
                  data-testid="filter-date-from"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Date to</label>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => handleFilterChange("dateTo", e.target.value)}
                  className="h-9 text-sm"
                  data-testid="filter-date-to"
                />
              </div>

              {albums && albums.length > 0 && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Album</label>
                  <Select
                    value={albumId || "__all__"}
                    onValueChange={(v) =>
                      handleFilterChange("albumId", v === "__all__" ? "" : v)
                    }
                  >
                    <SelectTrigger className="h-9 text-sm" data-testid="filter-album">
                      <SelectValue placeholder="Any album" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">Any album</SelectItem>
                      {albums.map((a) => (
                        <SelectItem key={a.id} value={String(a.id)}>
                          {a.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {me?.role === "admin" && users && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Uploader</label>
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

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">AI status</label>
                <Select
                  value={aiStatus || "__all__"}
                  onValueChange={(v) =>
                    handleFilterChange("aiStatus", v === "__all__" ? "" : v)
                  }
                >
                  <SelectTrigger className="h-9 text-sm" data-testid="filter-ai-status">
                    <SelectValue placeholder="All" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All</SelectItem>
                    <SelectItem value="has_description">Has description</SelectItem>
                    <SelectItem value="failed">Failed</SelectItem>
                    <SelectItem value="not_analysed">Not analysed</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {attributionTagList && attributionTagList.length > 0 && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Attribution</label>
                  <Select
                    value={attribution || "__all__"}
                    onValueChange={(v) =>
                      handleFilterChange("attribution", v === "__all__" ? "" : v)
                    }
                  >
                    <SelectTrigger className="h-9 text-sm" data-testid="filter-attribution">
                      <SelectValue placeholder="All" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">All</SelectItem>
                      <SelectItem value="none">No attribution</SelectItem>
                      {attributionTagList.map((t) => (
                        <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
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
                    <button type="button" onClick={() => handleFilterChange("ratingMin", "")} className="ml-1 hover:text-destructive">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )}
                {albumId && (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    Album: {albums?.find((a) => String(a.id) === albumId)?.title ?? albumId}
                    <button type="button" onClick={() => handleFilterChange("albumId", "")} className="ml-1 hover:text-destructive">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )}
                {dateFrom && (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    From: {dateFrom}
                    <button type="button" onClick={() => handleFilterChange("dateFrom", "")} className="ml-1 hover:text-destructive">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )}
                {dateTo && (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    To: {dateTo}
                    <button type="button" onClick={() => handleFilterChange("dateTo", "")} className="ml-1 hover:text-destructive">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )}
                {uploaderId && (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    Uploader: {users?.find((u) => String(u.id) === uploaderId)?.name ?? uploaderId}
                    <button type="button" onClick={() => handleFilterChange("uploaderId", "")} className="ml-1 hover:text-destructive">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )}
                {aiStatus && (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    <Bot className="h-3 w-3" />
                    AI:{" "}
                    {aiStatus === "has_description"
                      ? "Has description"
                      : aiStatus === "failed"
                      ? "Failed"
                      : "Not analysed"}
                    <button type="button" onClick={() => handleFilterChange("aiStatus", "")} className="ml-1 hover:text-destructive">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )}
                {attribution && (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    Attribution:{" "}
                    {attribution === "none"
                      ? "None"
                      : attributionTagList?.find((t) => String(t.id) === attribution)?.name ?? attribution}
                    <button type="button" onClick={() => handleFilterChange("attribution", "")} className="ml-1 hover:text-destructive">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )}
              </div>
            )}
          </div>
        )}

        {isInitialLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3" data-testid="photos-loading">
            <span role="status" className="sr-only">Loading photos…</span>
            {Array.from({ length: PAGE_SIZE }).map((_, i) => (
              <Skeleton key={i} className="aspect-square rounded-lg" />
            ))}
          </div>
        ) : allPhotos.length > 0 ? (
          <>
            <PhotoGrid
              items={allPhotos}
              getKey={(photo) => photo.id}
              densityOverride={zoom}
              data-testid="photos-grid"
              renderItem={(photo) => {
                const collections = photo.photoCollections ?? [];
                const isSelected = selectedIds.has(photo.id);
                return (
                  <div
                    key={photo.id}
                    draggable
                    onDragStart={(e) => startPhotoDrag(e, photo.id)}
                    className={cn(
                      "group relative h-full rounded-lg overflow-hidden border bg-muted",
                      isSelected ? "border-primary ring-2 ring-primary" : "border-border"
                    )}
                    data-testid="photo-grid-item"
                  >
                    {isSelectMode && (
                      <div className="absolute top-1.5 left-1.5 z-20 pointer-events-none">
                        <div className={cn(
                          "h-5 w-5 rounded border-2 flex items-center justify-center",
                          isSelected ? "bg-primary border-primary" : "bg-white/80 border-white"
                        )}>
                          {isSelected && <Check className="h-3 w-3 text-primary-foreground" />}
                        </div>
                      </div>
                    )}
                    <button
                      type="button"
                      className="block w-full h-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                      aria-label={photoControlLabel(isSelectMode ? "Select" : "Open", photo, { albumTitle: photo.albumTitle })}
                      aria-pressed={isSelectMode ? isSelected : undefined}
                      data-photo-id={photo.id}
                      onClick={() => {
                        if (isSelectMode) {
                          toggleSelection(photo.id);
                        } else {
                          setSelectedPhoto({
                            id: photo.id,
                            url: photo.url,
                            thumbnailKey: photo.thumbnailKey,
                            name: photo.filename,
                            averageRating: photo.averageRating,
                            albumId: photo.albumId,
                          });
                        }
                      }}
                    >
                      <FadeImage
                        src={photo.thumbnailKey ? `/api/storage${photo.thumbnailKey}` : photo.url}
                        alt=""
                        className={cn(
                          "w-full h-full object-cover transition-transform duration-200 group-hover:scale-105",
                          photo.isHidden && "opacity-60"
                        )}
                        loading="lazy"
                      />
                    </button>
                    <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex flex-col justify-end p-2.5 pointer-events-none">
                      {photo.albumTitle && (
                        photo.albumId ? (
                          <Link
                            href={`/albums/${photo.albumId}`}
                            className="text-xs text-white/80 truncate hover:text-white hover:underline pointer-events-auto"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {photo.albumTitle}
                          </Link>
                        ) : (
                          <p className="text-xs text-white/80 truncate">{photo.albumTitle}</p>
                        )
                      )}
                    </div>
                    {photo.averageRating != null && (
                      <div
                        className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 rounded-full bg-black/60 px-1.5 py-0.5 pointer-events-none"
                        data-testid="rating-badge"
                      >
                        <Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400" />
                        <span className="text-[10px] text-white font-medium leading-none">
                          {photo.averageRating.toFixed(1)}
                        </span>
                      </div>
                    )}
                    {photo.isHidden && (
                      <div
                        className="absolute top-1.5 left-1.5 flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5 shadow pointer-events-none"
                        title="Hidden photo"
                        data-testid="hidden-badge"
                      >
                        <EyeOff className="h-2.5 w-2.5 text-white" />
                        <span className="text-[10px] font-semibold text-white leading-none">Hidden</span>
                      </div>
                    )}
                    {photo.latestAiStatus === "failed" && !photo.aiDescription ? (
                      <button
                        type="button"
                        className="absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5 shadow hover:bg-black/90 transition-colors"
                        title={reanalyzingIds.has(photo.id) ? "Re-running AI analysis…" : "AI analysis failed — click to retry"}
                        data-testid="ai-badge"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRerunAnalysis(photo.id);
                        }}
                        disabled={reanalyzingIds.has(photo.id)}
                      >
                        {reanalyzingIds.has(photo.id) ? (
                          <Loader2 className="h-2.5 w-2.5 text-amber-400 animate-spin" />
                        ) : (
                          <>
                            <Bot className="h-2.5 w-2.5 text-amber-400" />
                            <AlertCircle className="h-2 w-2 text-amber-400" />
                          </>
                        )}
                      </button>
                    ) : photo.aiDescription ? (
                      <div
                        className="absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5 shadow pointer-events-none"
                        title="AI description available"
                        data-testid="ai-badge"
                      >
                        <Bot className="h-2.5 w-2.5 text-sky-300" />
                        <Check className="h-2 w-2 text-sky-300" />
                      </div>
                    ) : null}
                    {collections.length > 0 && (
                      <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center gap-1 pointer-events-none">
                        <span
                          className="inline-flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[9px] text-white leading-none max-w-[8rem] truncate"
                          title={collections[0].title}
                          data-testid="collection-pill"
                        >
                          <FolderOpen className="h-2 w-2 shrink-0" />
                          <span className="truncate">{collections[0].title}</span>
                        </span>
                        {collections.length > 1 && (
                          <span className="inline-flex items-center rounded-full bg-black/70 px-1.5 py-0.5 text-[9px] text-white leading-none">
                            +{collections.length - 1}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              }}
            />

            {hasMore && (
              <div
                ref={sentinelRef}
                className="flex items-center justify-center py-8 text-sm text-muted-foreground"
                data-testid="photos-load-more"
              >
                <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading more…
              </div>
            )}
          </>
        ) : (
          <div
            className="flex flex-col items-center justify-center py-24 text-center rounded-xl border border-border bg-card"
            data-testid="photos-empty"
          >
            <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center mb-4">
              <Camera className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="text-base font-medium text-foreground mb-1">
              {hasActiveFilters ? "No photos match your filters" : "No photos yet"}
            </h3>
            <p className="text-sm text-muted-foreground max-w-sm">
              {hasActiveFilters
                ? "Try adjusting or clearing your filters to see more results."
                : "Photos will appear here once they've been added to albums."}
            </p>
            {hasActiveFilters ? (
              <Button variant="outline" size="sm" className="mt-4" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : (
              // First-run CTAs (#148 Phase A): don't dead-end an empty library.
              <div className="mt-4 flex items-center gap-2">
                <Button asChild size="sm" className="gap-1.5">
                  <Link href="/bulk-upload" data-testid="photos-empty-upload">
                    <Upload className="h-4 w-4" />
                    Upload photos
                  </Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link href="/albums" data-testid="photos-empty-albums">Create an album</Link>
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {isSelectMode && (
        <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-background/95 backdrop-blur-sm px-4 py-3 flex items-center justify-between gap-4 shadow-lg" data-testid="select-action-bar">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-sm text-muted-foreground">
              {selectedIds.size} photo{selectedIds.size !== 1 ? "s" : ""} selected
            </span>
            <SelectionRightsSummary photos={allPhotos.filter((p) => selectedIds.has(p.id))} />
          </span>
          <div className="flex items-center gap-2">
            {caps.isOrgManager && selectedIds.size > 0 && (
              <Button
                variant="destructive"
                size="sm"
                className="gap-1.5"
                onClick={() => setConfirmBulkDelete(true)}
                disabled={bulkDeleting}
                data-testid="bulk-delete-btn"
              >
                {bulkDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Delete {selectedIds.size} photo{selectedIds.size !== 1 ? "s" : ""}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={exitSelectMode} data-testid="cancel-select-btn">
              Cancel
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={confirmBulkDelete} onOpenChange={setConfirmBulkDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.size} photo{selectedIds.size !== 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {selectedIds.size} selected photo{selectedIds.size !== 1 ? "s" : ""}. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDelete}
              className="bg-destructive hover:bg-destructive/90"
              data-testid="confirm-bulk-delete"
            >
              Delete photos
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>


      <PhotoLightbox
        photo={selectedPhoto}
        onClose={() => setSelectedPhoto(null)}
        hasPrev={lightboxHasPrev}
        hasNext={lightboxHasNext}
        onPrev={handleLightboxPrev}
        onNext={handleLightboxNext}
        onDeleted={(deletedId) => {
          setSelectedPhoto(null);
          qc.invalidateQueries({ queryKey: getListPhotosQueryKey().slice(0, 1) });
        }}
      />
    </AppLayout>
  );
}
