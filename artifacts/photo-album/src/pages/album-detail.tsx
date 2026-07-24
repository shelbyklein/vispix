import { useState, useRef, useEffect } from "react";
import { FadeImage } from "@/components/ui/fade-image";
import { useParams, Link, useLocation } from "wouter";
import {
  useGetAlbum,
  useListAlbumPhotos,
  listAlbumPhotos,
  useDeleteAlbum,
  useSetAlbumCover,
  useAcceptPhotoSuggestion,
  useDismissPhotoSuggestion,
  useAcceptPhotoNewCollectionSuggestion,
  useDismissPhotoNewCollectionSuggestion,
  useRerunPhotoAnalysis,
  useBulkDeletePhotos,
  useListAttributionTags,
  useGetAlbumAttributionSummary,
  getGetAlbumAttributionSummaryQueryKey,
  useSetAlbumAttribution,
  getGetAlbumQueryKey,
  getListAlbumPhotosQueryKey,
  getListAlbumsQueryKey,
  getListPhotosQueryKey,
  getGetRecentPhotosQueryKey,
  getGetTopRatedPhotosQueryKey,
  useGetMe,
} from "@workspace/api-client-react";
import type { Photo } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import { EditAlbumDialog } from "@/components/EditAlbumDialog";
import type { LightboxPhoto } from "@/components/PhotoLightbox";
import { PhotoGrid } from "@/components/PhotoGrid";
import { GridZoomControl } from "@/components/GridZoomControl";
import { useGridZoom } from "@/hooks/useGridZoom";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { startPhotoDrag } from "@/lib/photoDrag";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/format-date";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Star,
  CalendarDays,
  Camera,
  ArrowLeft,
  Trash2,
  CheckSquare,
  Upload,
  X,
  AlertCircle,
  ArrowUpDown,
  Sparkles,
  Loader2,
  Check,
  Plus,
  Copyright,
  EyeOff,
  Eye,
  Bot,
  FolderOpen,
  Copy,
  CopyCheck,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type SortOption = "newest" | "oldest" | "top-rated";

const PAGE_SIZE = 50;
const PREFETCH_THRESHOLD = 3;


function sortPhotos(photos: Photo[], sort: SortOption): Photo[] {
  const sorted = [...photos];
  if (sort === "newest") {
    sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  } else if (sort === "oldest") {
    sorted.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  } else if (sort === "top-rated") {
    sorted.sort((a, b) => {
      const ratingDiff = (b.averageRating ?? 0) - (a.averageRating ?? 0);
      if (ratingDiff !== 0) return ratingDiff;
      const countDiff = b.ratingCount - a.ratingCount;
      if (countDiff !== 0) return countDiff;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }
  return sorted;
}

// Duplicate / near-duplicate stat in the album header (#166). Amber, links to
// the admin review flow for admins; a plain badge for everyone else.
function DupStat({ isAdmin, href, icon, label }: { isAdmin: boolean; href: string; icon: React.ReactNode; label: string }) {
  const cls = "flex items-center gap-1 whitespace-nowrap text-amber-600 dark:text-amber-500";
  return isAdmin ? (
    <Link href={href} className={`${cls} hover:underline`}>{icon}{label}</Link>
  ) : (
    <span className={cls}>{icon}{label}</span>
  );
}

export default function AlbumDetail() {
  const { id } = useParams<{ id: string }>();
  const albumId = parseInt(id, 10);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [sort, setSort] = useState<SortOption>("newest");
  const [confirmNewCollection, setConfirmNewCollection] = useState<{
    photoId: number;
    suggestionId: number;
    name: string;
  } | null>(null);
  const [showHiddenLocal, setShowHiddenLocal] = useState(false);
  const [filterInCollection, setFilterInCollection] = useState<boolean | undefined>(undefined);
  const [filterHasRating, setFilterHasRating] = useState<boolean | undefined>(undefined);
  const [filterAiStatus, setFilterAiStatus] = useState<"has_description" | "not_analysed" | "failed" | undefined>(undefined);
  const [reanalyzingIds, setReanalyzingIds] = useState<Set<number>>(new Set());
  const { mutate: rerunAnalysis } = useRerunPhotoAnalysis();
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const { mutate: bulkDelete, isPending: bulkDeleting } = useBulkDeletePhotos();
  const { data: attributionTags } = useListAttributionTags();
  const [filterAttribution, setFilterAttribution] = useState<string>("all");
  const [offset, setOffset] = useState(0);
  const [allPhotos, setAllPhotos] = useState<Photo[]>([]);
  const [expandedSuggestions, setExpandedSuggestions] = useState<Set<number>>(new Set());
  const [hoveredSuggestions, setHoveredSuggestions] = useState<Set<number>>(new Set());
  const [selectedPhoto, setSelectedPhoto] = useState<LightboxPhoto | null>(null);
  const [pendingLightboxAdvance, setPendingLightboxAdvance] = useState(false);
  const [unratedReviewMode, setUnratedReviewMode] = useState(false);
  const prevAllPhotosLengthRef = useRef(0);
  const wasFetchingRef = useRef(false);
  const { zoom, setZoom } = useGridZoom();
  const { data: album, isLoading: albumLoading } = useGetAlbum(albumId, {
    query: { enabled: !!albumId, queryKey: getGetAlbumQueryKey(albumId) },
  });

  const hasActiveFilters = filterInCollection != null || filterHasRating != null || filterAiStatus != null || filterAttribution !== "all";

  function clearFilters() {
    setFilterInCollection(undefined);
    setFilterHasRating(undefined);
    setFilterAiStatus(undefined);
    setFilterAttribution("all");
  }

  const photosParams = {
    ...(showHiddenLocal ? { includeHidden: true as const } : {}),
    limit: PAGE_SIZE,
    offset,
    ...(filterInCollection != null ? { inCollection: filterInCollection } : {}),
    ...(filterHasRating != null ? { hasRating: filterHasRating } : {}),
    ...(filterAiStatus != null ? { aiStatus: filterAiStatus } : {}),
    // "all" = no filter; "none" = untagged; otherwise a specific tag id.
    ...(filterAttribution !== "all" && filterAttribution !== "none"
      ? { attributionTagId: parseInt(filterAttribution, 10) }
      : {}),
    ...(filterAttribution === "none" ? { hasAttribution: false } : {}),
  };
  const { data: photosPage, isLoading: photosPageLoading, isFetching: photosFetching } = useListAlbumPhotos(albumId, photosParams, {
    query: {
      enabled: !!albumId,
      queryKey: getListAlbumPhotosQueryKey(albumId, photosParams),
      refetchInterval: (q) => {
        const page = q.state.data as { photos?: Array<{ aiDescription?: string | null; createdAt?: string }> } | undefined;
        const data = page?.photos;
        if (!data) return false;
        const now = Date.now();
        const stillAnalyzing = data.some(
          (p) =>
            p.aiDescription == null &&
            p.createdAt &&
            now - new Date(p.createdAt).getTime() < 60_000,
        );
        return stillAnalyzing ? 10_000 : false;
      },
    },
  });

  const photosLoading = photosPageLoading && allPhotos.length === 0;
  const loadingMore = photosFetching && allPhotos.length > 0;
  const hasMore = photosPage?.hasMore ?? false;

  // Auto-load the next page when the bottom sentinel scrolls into view; the
  // "Load more" button stays as a manual fallback (e.g. observer not firing
  // in background tabs).
  const sentinelRef = useInfiniteScroll(() => {
    if (!photosFetching) setOffset((prev) => prev + PAGE_SIZE);
  }, hasMore);

  useEffect(() => {
    setOffset(0);
    setAllPhotos([]);
  }, [albumId, showHiddenLocal, filterInCollection, filterHasRating, filterAiStatus, filterAttribution]);

  useEffect(() => {
    if (photosPage === undefined) return;
    const newPhotos = photosPage.photos;
    if (offset === 0) {
      setAllPhotos(newPhotos);
    } else {
      setAllPhotos((prev) => {
        const newMap = new Map(newPhotos.map((p) => [p.id, p]));
        const existingIds = new Set(prev.map((p) => p.id));
        const updated = prev.map((p) => newMap.get(p.id) ?? p);
        const appended = newPhotos.filter((p) => !existingIds.has(p.id));
        return [...updated, ...appended];
      });
    }
  }, [photosPage, offset]);

  useEffect(() => {
    if (!pendingLightboxAdvance || !selectedPhoto) return;
    if (allPhotos.length > prevAllPhotosLengthRef.current) {
      const newPhoto = allPhotos[prevAllPhotosLengthRef.current];
      setPendingLightboxAdvance(false);
      if (newPhoto) {
        setSelectedPhoto({ id: newPhoto.id, url: newPhoto.url, thumbnailKey: newPhoto.thumbnailKey, name: newPhoto.filename, averageRating: newPhoto.averageRating, albumId });
      }
    }
  }, [allPhotos, pendingLightboxAdvance, selectedPhoto, albumId]);

  useEffect(() => {
    const wasFetching = wasFetchingRef.current;
    wasFetchingRef.current = photosFetching;
    if (wasFetching && !photosFetching && pendingLightboxAdvance) {
      if (allPhotos.length <= prevAllPhotosLengthRef.current) {
        setPendingLightboxAdvance(false);
      }
    }
  }, [photosFetching, pendingLightboxAdvance, allPhotos.length]);

  const prefetchedOffsetRef = useRef<number>(-1);
  useEffect(() => {
    prefetchedOffsetRef.current = -1;
  }, [albumId, showHiddenLocal, filterInCollection, filterHasRating, filterAiStatus]);

  const unratedPhotosRef = useRef<Photo[]>([]);
  useEffect(() => {
    unratedPhotosRef.current = unratedPhotos;
  });
  useEffect(() => {
    if (!unratedReviewMode || !selectedPhoto) return;
    const stillUnrated = unratedPhotosRef.current.some((p) => p.id === selectedPhoto.id);
    if (!stillUnrated) {
      const remaining = unratedPhotosRef.current;
      if (remaining.length > 0) {
        const next = remaining[0];
        setSelectedPhoto({ id: next.id, url: next.url, thumbnailKey: next.thumbnailKey, name: next.filename, averageRating: next.averageRating, albumId });
      } else {
        setSelectedPhoto(null);
        setUnratedReviewMode(false);
      }
    }
  }, [unratedReviewMode, selectedPhoto, albumId]);

  const { mutate: setCover } = useSetAlbumCover();
  const { data: me } = useGetMe();
  const { mutate: deleteAlbum, isPending: deletingAlbum } = useDeleteAlbum();
  const { mutate: acceptSuggestion } = useAcceptPhotoSuggestion();
  const { mutate: dismissSuggestion } = useDismissPhotoSuggestion();
  const { mutate: acceptNewCollectionSuggestion, isPending: acceptingNewCollection } = useAcceptPhotoNewCollectionSuggestion();
  const { mutate: dismissNewCollectionSuggestion } = useDismissPhotoNewCollectionSuggestion();

  function handleAcceptSuggestion(photoId: number, collectionId: number) {
    acceptSuggestion(
      { id: photoId, collectionId },
      {
        onSuccess: invalidate,
        onError: () => toast({ title: "Failed to accept suggestion", variant: "destructive" }),
      },
    );
  }

  function handleDismissSuggestion(photoId: number, collectionId: number) {
    dismissSuggestion(
      { id: photoId, collectionId },
      {
        onSuccess: invalidate,
        onError: () => toast({ title: "Failed to dismiss suggestion", variant: "destructive" }),
      },
    );
  }

  function handleAcceptNewCollectionSuggestion(photoId: number, suggestionId: number, name: string) {
    acceptNewCollectionSuggestion(
      { id: photoId, suggestionId, data: { name } },
      {
        onSuccess: () => {
          setConfirmNewCollection(null);
          invalidate();
        },
        onError: () => toast({ title: "Failed to create collection", variant: "destructive" }),
      },
    );
  }

  function handleDismissNewCollectionSuggestion(photoId: number, suggestionId: number) {
    dismissNewCollectionSuggestion(
      { id: photoId, suggestionId },
      {
        onSuccess: invalidate,
        onError: () => toast({ title: "Failed to dismiss suggestion", variant: "destructive" }),
      },
    );
  }

  function invalidate() {
    setOffset(0);
    qc.invalidateQueries({ queryKey: getGetAlbumQueryKey(albumId) });
    qc.invalidateQueries({ queryKey: [`/api/albums/${albumId}/photos`] });
    qc.invalidateQueries({ queryKey: getListAlbumsQueryKey() });
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

  // Attribution is decided per album: apply or remove one tag on EVERY photo
  // in the album. Individual photos only display their tags.
  const { data: attributionSummary } = useGetAlbumAttributionSummary(albumId, {
    query: { enabled: !!albumId, queryKey: getGetAlbumAttributionSummaryQueryKey(albumId) },
  });
  const { mutate: setAlbumAttribution, isPending: settingAttribution } = useSetAlbumAttribution();

  function handleAlbumAttribution(tagId: number, tagName: string, mode: "add" | "remove") {
    setAlbumAttribution(
      { id: albumId, data: { tagId, mode } },
      {
        onSuccess: (r) => {
          toast({
            title:
              mode === "add"
                ? `Album cleared for "${tagName}" (${r.updated} photo${r.updated !== 1 ? "s" : ""} tagged)`
                : `"${tagName}" removed from the album`,
          });
          qc.invalidateQueries({ queryKey: getGetAlbumAttributionSummaryQueryKey(albumId) });
          // Individual photo queries carry attributionTags — refresh any that are cached.
          qc.invalidateQueries({
            predicate: (q) => typeof q.queryKey[0] === "string" && /^\/api\/photos\/\d+$/.test(q.queryKey[0]),
          });
          qc.invalidateQueries({ queryKey: [`/api/albums/${albumId}/photos`] });
        },
        onError: () => toast({ title: "Failed to update album attribution", variant: "destructive" }),
      },
    );
  }

  function handleBulkDelete() {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    bulkDelete(
      { data: { ids } },
      {
        onSuccess: (result) => {
          toast({ title: `${result.deleted} photo${result.deleted !== 1 ? "s" : ""} deleted` });
          invalidate();
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

  function handleSetCover(photoId: number) {
    setCover(
      { id: albumId, data: { photoId } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetAlbumQueryKey(albumId) });
          toast({ title: "Cover photo updated" });
        },
      }
    );
  }

  function handleDeleteAlbum() {
    deleteAlbum(
      { id: albumId },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListAlbumsQueryKey() });
          toast({ title: "Album deleted" });
          navigate("/albums");
        },
        onError: () =>
          toast({ title: "Failed to delete album", variant: "destructive" }),
      }
    );
  }

  const sortedPhotos = sortPhotos(
    showHiddenLocal ? allPhotos : allPhotos.filter((p) => !p.isHidden),
    sort,
  );

  const unratedPhotos = sortedPhotos.filter((p) => p.ratingCount === 0);
  const lightboxPhotos = unratedReviewMode ? unratedPhotos : sortedPhotos;

  useEffect(() => {
    if (!selectedPhoto || !hasMore) return;
    const idx = sortedPhotos.findIndex((p) => p.id === selectedPhoto.id);
    if (idx < 0) return;
    const distanceFromEnd = sortedPhotos.length - 1 - idx;
    if (distanceFromEnd > PREFETCH_THRESHOLD) return;
    const nextOffset = offset + PAGE_SIZE;
    if (prefetchedOffsetRef.current === nextOffset) return;
    prefetchedOffsetRef.current = nextOffset;
    const nextParams = {
      ...(showHiddenLocal ? { includeHidden: true as const } : {}),
      limit: PAGE_SIZE,
      offset: nextOffset,
      ...(filterInCollection != null ? { inCollection: filterInCollection } : {}),
      ...(filterHasRating != null ? { hasRating: filterHasRating } : {}),
      ...(filterAiStatus != null ? { aiStatus: filterAiStatus } : {}),
    };
    qc.prefetchQuery({
      queryKey: getListAlbumPhotosQueryKey(albumId, nextParams),
      queryFn: () => listAlbumPhotos(albumId, nextParams),
    });
  }, [selectedPhoto, sortedPhotos, hasMore, offset, showHiddenLocal, filterInCollection, filterHasRating, filterAiStatus, albumId, qc]);

  if (albumLoading) {
    return (
      <AppLayout>
        <div className="space-y-6">
          <Skeleton className="h-8 w-64" />
          <div className="grid grid-cols-3 lg:grid-cols-4 gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="aspect-square rounded-lg" />
            ))}
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!album) {
    return (
      <AppLayout>
        <div className="text-center py-24">
          <p className="text-muted-foreground">Album not found.</p>
          <Link href="/albums">
            <Button variant="outline" className="mt-4">
              Back to Albums
            </Button>
          </Link>
        </div>
      </AppLayout>
    );
  }

  const visiblePhotoCount = showHiddenLocal
    ? album.photoCount
    : album.photoCount - (album.hiddenCount ?? 0);

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="album-detail-page">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <Link href="/albums">
              <Button
                variant="ghost"
                size="icon"
                className="mt-0.5 shrink-0"
                data-testid="back-to-albums"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <div className="flex items-center gap-1.5">
                <h1
                  className="text-lg sm:text-2xl font-bold text-foreground"
                  data-testid="album-title"
                >
                  {album.title}
                </h1>
                {/* PATCH /albums/:id allows the owner or a platform admin. */}
                {(me?.role === "admin" || album.ownerId === me?.id) && (
                  <EditAlbumDialog
                    albumId={albumId}
                    title={album.title}
                    description={album.description}
                    eventDate={album.eventDate}
                    folder={album.folder}
                    onSaved={invalidate}
                  />
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-sm text-muted-foreground">
                {album.eventDate && (
                  <span className="flex items-center gap-1 whitespace-nowrap">
                    <CalendarDays className="h-3.5 w-3.5" />
                    {formatDate(album.eventDate)}
                  </span>
                )}
                <span className="flex items-center gap-1 whitespace-nowrap">
                  <Camera className="h-3.5 w-3.5" />
                  {album.photoCount} photo{album.photoCount !== 1 ? "s" : ""}
                </span>
                {/* Duplicate / near-duplicate heads-up (#166). Admins link to
                    the review flow; others just see the count. */}
                {!!album.duplicateCount && (
                  <DupStat
                    isAdmin={me?.role === "admin"}
                    href="/admin/duplicates"
                    icon={<Copy className="h-3.5 w-3.5" />}
                    label={`${album.duplicateCount} duplicate${album.duplicateCount !== 1 ? "s" : ""}`}
                  />
                )}
                {!!album.nearDuplicateCount && (
                  <DupStat
                    isAdmin={me?.role === "admin"}
                    href="/admin/near-duplicates"
                    icon={<CopyCheck className="h-3.5 w-3.5" />}
                    label={`${album.nearDuplicateCount} near-dup${album.nearDuplicateCount !== 1 ? "s" : ""}`}
                  />
                )}
                {me?.role === "admin" && !!album.hiddenCount && (
                  <span className="flex items-center gap-1 text-muted-foreground/70 whitespace-nowrap">
                    <EyeOff className="h-3 w-3" />
                    {album.hiddenCount} hidden
                    <button
                      type="button"
                      onClick={() => setShowHiddenLocal((v) => !v)}
                      className={`flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium transition-colors ${showHiddenLocal ? "bg-primary/10 text-primary" : "hover:bg-muted text-muted-foreground/70 hover:text-muted-foreground"}`}
                      data-testid="toggle-hidden-photos"
                      title={showHiddenLocal ? "Hide hidden photos" : "Show hidden photos"}
                    >
                      {showHiddenLocal ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                      {showHiddenLocal ? "hide" : "show"}
                    </button>
                  </span>
                )}
              </div>
              {album.description && (
                <p className="text-sm text-muted-foreground mt-2 max-w-xl">
                  {album.description}
                </p>
              )}
            </div>
          </div>

          <TooltipProvider delayDuration={500}>
          {/* Phones: 2x2 grid of compact actions; sm and up: single row. */}
          <div className="grid grid-cols-2 gap-2 shrink-0 sm:flex sm:items-center">
            {me?.role === "admin" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={isSelectMode ? "default" : "outline"}
                    size="sm"
                    className="gap-1.5"
                    onClick={() => isSelectMode ? exitSelectMode() : setIsSelectMode(true)}
                    data-testid="toggle-select-mode"
                    aria-label={isSelectMode ? "Cancel selection" : "Select photos"}
                  >
                    <CheckSquare className="h-4 w-4" />
                    <span className="hidden sm:inline">{isSelectMode ? "Cancel" : "Select"}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{isSelectMode ? "Cancel selection" : "Select photos"}</TooltipContent>
              </Tooltip>
            )}
            {!photosLoading && unratedPhotos.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => {
                      const first = unratedPhotos[0];
                      setUnratedReviewMode(true);
                      setSelectedPhoto({ id: first.id, url: first.url, thumbnailKey: first.thumbnailKey, name: first.filename, averageRating: first.averageRating, albumId });
                    }}
                    data-testid="review-unrated-btn"
                    aria-label={`Review unrated photos (${album.unratedCount ?? unratedPhotos.length})`}
                  >
                    <Star className="h-4 w-4" />
                    <span className="hidden sm:inline">Review Unrated ({album.unratedCount ?? unratedPhotos.length})</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Review unrated ({album.unratedCount ?? unratedPhotos.length})</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild size="sm" className="gap-1.5" data-testid="album-bulk-upload-btn">
                  <Link href={`/bulk-upload?albumId=${albumId}`} aria-label="Upload to this album">
                    <Upload className="h-4 w-4" />
                    <span className="hidden sm:inline">Upload</span>
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Upload to this album</TooltipContent>
            </Tooltip>

            {me?.role === "admin" && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="w-full sm:w-9"
                    data-testid="delete-album-btn"
                    title="Delete album"
                  >
                    <Trash2 className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this album?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete "{album.title}" and all its photos. This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDeleteAlbum}
                      disabled={deletingAlbum}
                      className="bg-destructive hover:bg-destructive/90"
                      data-testid="confirm-delete-album"
                    >
                      {deletingAlbum ? "Deleting…" : "Delete Album"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
          </TooltipProvider>
        </div>

        {/* Album-level attribution: clearing an album for a use tags every
            photo in it. Pills are tri-state — none / partial (amber, n/total) /
            all — and only admins can toggle them. */}
        {attributionSummary && attributionSummary.tags.length > 0 && album && album.photoCount > 0 && (
          <div className="flex flex-wrap items-center gap-2" data-testid="album-attribution-row">
            <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Copyright className="h-3.5 w-3.5" /> Attribution
            </span>
            {attributionSummary.tags.map((tag) => {
              const total = attributionSummary.photoCount;
              const all = total > 0 && tag.count === total;
              const partial = tag.count > 0 && !all;
              const clickable = me?.role === "admin";
              return (
                <button
                  key={tag.id}
                  type="button"
                  disabled={!clickable || settingAttribution}
                  onClick={() => clickable && handleAlbumAttribution(tag.id, tag.name, all ? "remove" : "add")}
                  title={
                    clickable
                      ? all
                        ? `Remove "${tag.name}" from every photo in this album`
                        : `Clear every photo in this album for "${tag.name}"`
                      : undefined
                  }
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors disabled:opacity-70 ${
                    all
                      ? "bg-primary text-primary-foreground border-primary hover:bg-primary/85"
                      : partial
                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/50 hover:bg-amber-500/25"
                      : "bg-transparent text-muted-foreground border-border hover:bg-muted hover:text-foreground"
                  } ${!clickable ? "cursor-default" : ""}`}
                  data-testid={`album-attribution-pill-${tag.id}`}
                  aria-pressed={all}
                >
                  {all ? <Check className="h-3 w-3 shrink-0" /> : clickable ? <Plus className="h-3 w-3 shrink-0" /> : null}
                  {tag.name}
                  {partial && (
                    <span className="text-[10px] opacity-80">
                      {tag.count}/{total}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {!photosLoading && album && (album.photoCount > 0 || hasActiveFilters) && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
              <Select value={sort} onValueChange={(v) => setSort(v as SortOption)}>
                <SelectTrigger className="h-8 w-36 text-sm" data-testid="sort-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Newest first</SelectItem>
                  <SelectItem value="oldest">Oldest first</SelectItem>
                  <SelectItem value="top-rated">Top rated</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="h-4 w-px bg-border" />

            <Select
              value={filterInCollection == null ? "all" : String(filterInCollection)}
              onValueChange={(v) => setFilterInCollection(v === "all" ? undefined : v === "true")}
            >
              <SelectTrigger className="h-8 w-44 text-sm" data-testid="filter-collection-select">
                <SelectValue placeholder="Collection" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any collection</SelectItem>
                <SelectItem value="true">In a collection</SelectItem>
                <SelectItem value="false">Not in collection</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={filterHasRating == null ? "all" : String(filterHasRating)}
              onValueChange={(v) => setFilterHasRating(v === "all" ? undefined : v === "true")}
            >
              <SelectTrigger className="h-8 w-36 text-sm" data-testid="filter-rating-select">
                <SelectValue placeholder="Rating" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any rating</SelectItem>
                <SelectItem value="true">Has rating</SelectItem>
                <SelectItem value="false">Not rated</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={filterAiStatus ?? "all"}
              onValueChange={(v) =>
                setFilterAiStatus(
                  v === "all" ? undefined : (v as "has_description" | "not_analysed" | "failed"),
                )
              }
            >
              <SelectTrigger className="h-8 w-44 text-sm" data-testid="filter-ai-select">
                <SelectValue placeholder="AI status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any AI status</SelectItem>
                <SelectItem value="has_description">Has AI description</SelectItem>
                <SelectItem value="not_analysed">Not yet analysed</SelectItem>
                <SelectItem value="failed">Analysis failed</SelectItem>
              </SelectContent>
            </Select>

            {attributionTags && attributionTags.length > 0 && (
              <Select value={filterAttribution} onValueChange={setFilterAttribution}>
                <SelectTrigger className="h-8 w-44 text-sm" data-testid="filter-attribution-select">
                  <SelectValue placeholder="Attribution" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any attribution</SelectItem>
                  <SelectItem value="none">No attribution</SelectItem>
                  {attributionTags.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                data-testid="clear-filters-btn"
              >
                <X className="h-3 w-3" />
                Clear filters
              </button>
            )}

            <span className="text-xs text-muted-foreground ml-auto">
              {hasActiveFilters
                ? `${allPhotos.length}${hasMore ? "+" : ""} photo${allPhotos.length !== 1 ? "s" : ""} (filtered)`
                : `${visiblePhotoCount} photo${visiblePhotoCount !== 1 ? "s" : ""}`}
            </span>
            <GridZoomControl zoom={zoom} setZoom={setZoom} />
          </div>
        )}

        {photosLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[4/3] rounded-lg" />
            ))}
          </div>
        ) : sortedPhotos.length > 0 ? (
          <>
          <PhotoGrid
            items={sortedPhotos}
            getKey={(photo) => photo.id}
            densityOverride={zoom}
            data-testid="photo-grid"
            renderItem={(photo) => {
              const collections = photo.photoCollections ?? [];
              const isSelected = selectedIds.has(photo.id);
              return (
              <div
                key={photo.id}
                draggable
                onDragStart={(e) => startPhotoDrag(e, photo.id)}
                className={`relative group h-full rounded-lg overflow-hidden bg-muted${isSelected ? " ring-2 ring-primary" : ""}`}
                data-testid="photo-grid-item"
              >
                {isSelectMode && (
                  <div className="absolute top-2 left-2 z-20 pointer-events-none">
                    <div className={`h-5 w-5 rounded border-2 flex items-center justify-center ${isSelected ? "bg-primary border-primary" : "bg-white/80 border-white"}`}>
                      {isSelected && <Check className="h-3 w-3 text-primary-foreground" />}
                    </div>
                  </div>
                )}
                <button
                  type="button"
                  className={`w-full h-full block${photo.isHidden ? " opacity-60" : ""}`}
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
                        albumId,
                      });
                    }
                  }}
                  aria-label={`Open ${photo.filename ?? "photo"} in lightbox`}
                  data-testid="photo-thumbnail-btn"
                >
                  <FadeImage
                    src={photo.thumbnailKey ? `/api/storage${photo.thumbnailKey}` : photo.url}
                    alt={photo.filename ?? "Photo"}
                    loading="lazy"
                    className="w-full h-full object-cover cursor-pointer transition-transform duration-200 group-hover:scale-105"
                  />
                </button>

                {photo.isHidden && (
                  <div
                    className="absolute top-2 left-2 flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5 z-10"
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
                    className="absolute top-2 right-2 flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5 z-10 hover:bg-black/90 transition-colors"
                    title={reanalyzingIds.has(photo.id) ? "Re-running AI analysis…" : "AI analysis failed — click to retry"}
                    data-testid="ai-badge"
                    onClick={(e) => {
                      e.stopPropagation();
                      const photoId = photo.id;
                      setReanalyzingIds((prev) => new Set(prev).add(photoId));
                      rerunAnalysis(
                        { id: photoId },
                        {
                          onSuccess: () => {
                            toast({ title: "AI analysis started" });
                            qc.invalidateQueries({ queryKey: getListAlbumPhotosQueryKey(albumId) });
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
                    className="absolute top-2 right-2 flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5 z-10"
                    title="AI description available"
                    data-testid="ai-badge"
                  >
                    <Bot className="h-2.5 w-2.5 text-sky-300" />
                    <Check className="h-2 w-2 text-sky-300" />
                  </div>
                ) : null}

                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-all duration-200 pointer-events-none" />

                <div className="absolute bottom-2 left-2 right-2 flex items-end justify-between gap-1 z-10">
                  <div className="flex flex-wrap gap-1 min-w-0">
                    {collections.length > 0 && (
                      <>
                        <span
                          className="inline-flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[9px] text-white leading-none max-w-[7rem] truncate"
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
                      </>
                    )}
                  </div>

                  {photo.averageRating != null && (
                    <div className="flex items-center gap-0.5 bg-black/60 rounded-full px-1.5 py-0.5 shrink-0">
                      <Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400" />
                      <span className="text-[10px] text-white font-medium leading-none">
                        {photo.averageRating.toFixed(1)}
                      </span>
                    </div>
                  )}
                </div>

                {album.coverPhotoId === photo.id && (
                  <div className="absolute top-2 left-2 bg-primary text-primary-foreground text-[10px] px-1.5 py-0.5 rounded font-medium z-10">
                    Cover
                  </div>
                )}
              </div>
              );
            }}
          />
          {hasMore && (
            <div ref={sentinelRef} className="flex justify-center pt-4">
              <Button
                variant="outline"
                onClick={() => setOffset((prev) => prev + PAGE_SIZE)}
                disabled={loadingMore}
                data-testid="load-more-btn"
              >
                {loadingMore ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Loading…
                  </>
                ) : (
                  "Load more"
                )}
              </Button>
            </div>
          )}
          </>
        ) : hasActiveFilters ? (
          <div
            className="flex flex-col items-center justify-center py-24 text-center border-2 border-dashed border-border rounded-xl"
            data-testid="no-photos-filtered"
          >
            <AlertCircle className="h-10 w-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium text-foreground mb-1">No photos match the active filters</p>
            <p className="text-xs text-muted-foreground mb-4">
              Try adjusting or clearing the filters to see more photos.
            </p>
            <button
              type="button"
              onClick={clearFilters}
              className="text-sm text-primary hover:underline"
              data-testid="clear-filters-empty-btn"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div
            className="flex flex-col items-center justify-center py-24 text-center border-2 border-dashed border-border rounded-xl"
            data-testid="no-photos"
          >
            <Camera className="h-10 w-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium text-foreground mb-1">No photos yet</p>
            <p className="text-xs text-muted-foreground mb-4">
              Upload the first photos to this album.
            </p>
            <Button asChild size="sm" className="gap-1.5" data-testid="empty-upload-btn">
              <Link href={`/bulk-upload?albumId=${albumId}`}>
                <Upload className="h-4 w-4" />
                Upload Photos
              </Link>
            </Button>
          </div>
        )}
      </div>

      <Dialog
        open={confirmNewCollection !== null}
        onOpenChange={(open) => { if (!open) setConfirmNewCollection(null); }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Create new collection</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Edit the name before creating this collection.
          </p>
          <Input
            value={confirmNewCollection?.name ?? ""}
            onChange={(e) =>
              setConfirmNewCollection((prev) =>
                prev ? { ...prev, name: e.target.value } : prev
              )
            }
            placeholder="Collection name"
            data-testid="confirm-new-collection-name-input"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && confirmNewCollection?.name.trim()) {
                handleAcceptNewCollectionSuggestion(
                  confirmNewCollection.photoId,
                  confirmNewCollection.suggestionId,
                  confirmNewCollection.name.trim(),
                );
              }
            }}
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="outline"
              onClick={() => setConfirmNewCollection(null)}
              disabled={acceptingNewCollection}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (confirmNewCollection?.name.trim()) {
                  handleAcceptNewCollectionSuggestion(
                    confirmNewCollection.photoId,
                    confirmNewCollection.suggestionId,
                    confirmNewCollection.name.trim(),
                  );
                }
              }}
              disabled={acceptingNewCollection || !confirmNewCollection?.name.trim()}
              data-testid="confirm-new-collection-btn"
            >
              {acceptingNewCollection ? "Creating…" : "Create collection"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {isSelectMode && (
        <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-background/95 backdrop-blur-sm px-4 py-3 flex items-center justify-between gap-4 shadow-lg" data-testid="select-action-bar">
          <span className="text-sm text-muted-foreground">
            {selectedIds.size} photo{selectedIds.size !== 1 ? "s" : ""} selected
          </span>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {me?.role === "admin" && selectedIds.size > 0 && (
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
        onClose={() => { setSelectedPhoto(null); setPendingLightboxAdvance(false); setUnratedReviewMode(false); }}
        hasPrev={selectedPhoto !== null && lightboxPhotos.findIndex((p) => p.id === selectedPhoto.id) > 0}
        hasNext={selectedPhoto !== null && (
          lightboxPhotos.findIndex((p) => p.id === selectedPhoto.id) < lightboxPhotos.length - 1 ||
          (!unratedReviewMode && hasMore)
        )}
        isLoadingNext={pendingLightboxAdvance}
        albumId={albumId}
        coverPhotoId={album?.coverPhotoId}
        onDeleted={(deletedId) => {
          setSelectedPhoto(null);
          setPendingLightboxAdvance(false);
          setUnratedReviewMode(false);
          invalidate();
          qc.invalidateQueries({ queryKey: getListPhotosQueryKey().slice(0, 1) });
          qc.invalidateQueries({ queryKey: getGetRecentPhotosQueryKey() });
          qc.invalidateQueries({ queryKey: getGetTopRatedPhotosQueryKey() });
        }}
        onPrev={() => {
          if (!selectedPhoto) return;
          const idx = lightboxPhotos.findIndex((p) => p.id === selectedPhoto.id);
          if (idx > 0) {
            const p = lightboxPhotos[idx - 1];
            setSelectedPhoto({ id: p.id, url: p.url, thumbnailKey: p.thumbnailKey, name: p.filename, averageRating: p.averageRating, albumId });
          }
        }}
        onNext={() => {
          if (!selectedPhoto || pendingLightboxAdvance) return;
          const idx = lightboxPhotos.findIndex((p) => p.id === selectedPhoto.id);
          if (idx < lightboxPhotos.length - 1) {
            const p = lightboxPhotos[idx + 1];
            setSelectedPhoto({ id: p.id, url: p.url, thumbnailKey: p.thumbnailKey, name: p.filename, averageRating: p.averageRating, albumId });
          } else if (!unratedReviewMode && hasMore) {
            prevAllPhotosLengthRef.current = allPhotos.length;
            setPendingLightboxAdvance(true);
            setOffset((prev) => prev + PAGE_SIZE);
          }
        }}
      />
    </AppLayout>
  );
}
