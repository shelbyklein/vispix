import { useState, useMemo, useEffect } from "react";
import { photoControlLabel } from "@/lib/photo-a11y";
import { useParams, Link } from "wouter";
import { useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import {
  useGetCollection,
  getSmartCollectionPhotos,
  useAddPhotoToCollection,
  useUpdateCollection,
  useSetCollectionCover,
  useListCollectionNegativePhotos,
  useAddNegativePhotoToCollection,
  useRemoveNegativePhotoFromCollection,
  getGetCollectionQueryKey,
  getGetSmartCollectionPhotosQueryKey,
  getListCollectionNegativePhotosQueryKey,
} from "@workspace/api-client-react";
import type { Photo } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { FadeImage } from "@/components/ui/fade-image";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PhotoLightbox, type LightboxPhoto } from "@/components/PhotoLightbox";
import { PhotoGrid } from "@/components/PhotoGrid";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { startPhotoDrag } from "@/lib/photoDrag";
import { ArrowLeft, Sparkles, Star, ArrowUpDown, Plus, Check, Loader2, ImageIcon, Search, Ban, X, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Page size for ranked suggestions; scrolling keeps fetching deeper pages of
// the ranking until it's exhausted (#104).
const SMART_TOP_K = 100;

type SortOption = "relevance" | "newest" | "oldest" | "top-rated" | "name-az";

type RichPhoto = Photo;

function toLight(photo: RichPhoto): LightboxPhoto {
  return {
    id: photo.id,
    url: photo.url,
    thumbnailKey: photo.thumbnailKey,
    name: photo.filename,
    averageRating: photo.averageRating,
    albumId: photo.albumId,
  };
}

function sortPhotos(photos: RichPhoto[], sort: SortOption): RichPhoto[] {
  // "relevance" keeps the semantic (similarity-ranked) order as returned.
  if (sort === "relevance") return photos;
  const copy = [...photos];
  switch (sort) {
    case "newest":
      return copy.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    case "oldest":
      return copy.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    case "top-rated":
      return copy.sort((a, b) => {
        const rd = (b.averageRating ?? 0) - (a.averageRating ?? 0);
        if (rd !== 0) return rd;
        return b.ratingCount - a.ratingCount;
      });
    case "name-az":
      return copy.sort((a, b) => (a.filename ?? "").localeCompare(b.filename ?? ""));
  }
}

// Also serves People (collections with kind='person') at /people/:id — same
// members-first + similarity-suggestions experience, person-flavoured copy.
export default function SmartCollectionDetail({ variant = "collection" }: { variant?: "collection" | "person" } = {}) {
  const isPerson = variant === "person";
  const { id } = useParams<{ id: string }>();
  const collectionId = parseInt(id, 10);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: collection, isLoading: collectionLoading } = useGetCollection(collectionId, {
    query: { enabled: !!collectionId, queryKey: getGetCollectionQueryKey(collectionId) },
  });

  // The semantic term defaults to the saved smartQuery, else the collection title.
  const savedTerm = collection?.smartQuery ?? collection?.title ?? "";
  const [termInput, setTermInput] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (collection) setTermInput(collection.smartQuery ?? collection.title ?? "");
  }, [collection?.smartQuery, collection?.title]);

  const term = termInput.trim();
  // Members drive the matches (centroid of their embeddings); the term is only
  // the fallback when the collection is empty.
  const memberCount = collection?.photoCount ?? 0;
  const isMemberDriven = memberCount > 0;

  const { mutate: updateCollection } = useUpdateCollection();

  // The collection's own members always show; the semantic suggestions are
  // opt-out via the checkbox (and their query doesn't even run when off).
  const [includeSuggestions, setIncludeSuggestions] = useState(true);

  // Ranked suggestions page in SMART_TOP_K chunks via offset; a page shorter
  // than the chunk size means the ranking is exhausted.
  const smartPhotosKey = [...getGetSmartCollectionPhotosQueryKey(collectionId), "infinite"];
  const {
    data: suggestionPages,
    isLoading: suggestionsLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: smartPhotosKey,
    enabled: !!collectionId && includeSuggestions,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getSmartCollectionPhotos(collectionId, { topK: SMART_TOP_K, offset: pageParam as number }),
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length < SMART_TOP_K
        ? undefined
        : allPages.reduce((n, page) => n + page.length, 0),
  });
  const rawPhotos = useMemo(() => suggestionPages?.pages.flat(), [suggestionPages]);
  const photosLoading = includeSuggestions && suggestionsLoading;

  const sentinelRef = useInfiniteScroll(() => {
    if (!isFetchingNextPage) void fetchNextPage();
  }, includeSuggestions && !!hasNextPage);

  const negativesKey = getListCollectionNegativePhotosQueryKey(collectionId);
  const { data: negativePhotos } = useListCollectionNegativePhotos(collectionId, {
    query: { enabled: !!collectionId, queryKey: negativesKey },
  });

  const [sort, setSort] = useState<SortOption>("relevance");
  const [selectedPhoto, setSelectedPhoto] = useState<LightboxPhoto | null>(null);
  const [addingIds, setAddingIds] = useState<Set<number>>(new Set());
  const [markingIds, setMarkingIds] = useState<Set<number>>(new Set());

  const collectionPhotoIds = useMemo(
    () => new Set((collection?.photos ?? []).map((p) => p.id)),
    [collection?.photos],
  );

  // After any positive/negative change the centroid shifts — re-rank + refresh both lists.
  function invalidateSmart() {
    queryClient.invalidateQueries({ queryKey: getGetCollectionQueryKey(collectionId) });
    queryClient.invalidateQueries({ queryKey: smartPhotosKey });
    queryClient.invalidateQueries({ queryKey: negativesKey });
  }

  const addPhotoMutation = useAddPhotoToCollection({
    mutation: { onSuccess: invalidateSmart },
  });
  const addNegativeMutation = useAddNegativePhotoToCollection({
    mutation: { onSuccess: invalidateSmart },
  });
  const removeNegativeMutation = useRemoveNegativePhotoFromCollection({
    mutation: { onSuccess: invalidateSmart },
  });

  const [settingCoverId, setSettingCoverId] = useState<number | null>(null);
  const { mutate: setCollectionCover } = useSetCollectionCover({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCollectionQueryKey(collectionId) });
        toast({ title: "Cover photo updated" });
      },
      onError: () => toast({ title: "Failed to set cover photo", variant: "destructive" }),
      onSettled: () => setSettingCoverId(null),
    },
  });

  function handleSetCover(photoId: number, e: React.MouseEvent) {
    e.stopPropagation();
    if (settingCoverId !== null) return;
    setSettingCoverId(photoId);
    setCollectionCover({ id: collectionId, data: { photoId } });
  }

  function handleSaveTerm(e: React.FormEvent) {
    e.preventDefault();
    const next = termInput.trim();
    setIsSaving(true);
    updateCollection(
      { id: collectionId, data: { smartQuery: next || null } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetCollectionQueryKey(collectionId) });
          queryClient.invalidateQueries({ queryKey: smartPhotosKey });
          toast({ title: "Search term saved" });
        },
        onError: () => toast({ title: "Failed to save term", variant: "destructive" }),
        onSettled: () => setIsSaving(false),
      },
    );
  }

  function handleAddPhoto(photoId: number, e: React.MouseEvent) {
    e.stopPropagation();
    if (collectionPhotoIds.has(photoId) || addingIds.has(photoId)) return;
    setAddingIds((prev) => new Set(prev).add(photoId));
    addPhotoMutation.mutate(
      { id: collectionId, data: { photoId } },
      {
        onSettled: () => {
          setAddingIds((prev) => {
            const next = new Set(prev);
            next.delete(photoId);
            return next;
          });
        },
      },
    );
  }

  function handleMarkNegative(photoId: number, e: React.MouseEvent) {
    e.stopPropagation();
    if (markingIds.has(photoId)) return;
    setMarkingIds((prev) => new Set(prev).add(photoId));
    addNegativeMutation.mutate(
      { id: collectionId, data: { photoId } },
      {
        onSettled: () =>
          setMarkingIds((prev) => {
            const next = new Set(prev);
            next.delete(photoId);
            return next;
          }),
      },
    );
  }

  function handleUnmarkNegative(photoId: number) {
    removeNegativeMutation.mutate({ id: collectionId, photoId });
  }

  // Members first (they ARE the collection), then the ranked suggestions.
  // Suggestions already exclude members server-side, so no dedupe needed.
  const memberPhotos = useMemo(
    () => sortPhotos((collection?.photos ?? []) as RichPhoto[], sort),
    [collection?.photos, sort],
  );
  const suggestionPhotos = useMemo(() => {
    if (!includeSuggestions || !rawPhotos) return [];
    return sortPhotos(rawPhotos as RichPhoto[], sort);
  }, [includeSuggestions, rawPhotos, sort]);
  const photos = useMemo(
    () => [...memberPhotos, ...suggestionPhotos],
    [memberPhotos, suggestionPhotos],
  );

  const selectedIndex = selectedPhoto ? photos.findIndex((p) => p.id === selectedPhoto.id) : -1;
  const hasPrev = selectedIndex > 0;
  const hasNext = selectedIndex >= 0 && selectedIndex < photos.length - 1;

  const isLoading = collectionLoading || photosLoading;

  if (!collectionLoading && !collection) {
    return (
      <AppLayout>
        <div className="text-center py-24">
          <p className="text-muted-foreground">Collection not found.</p>
          <Link href="/dashboard">
            <Button variant="outline" className="mt-4">Back to Dashboard</Button>
          </Link>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="smart-collection-detail-page">
        <div className="flex items-start gap-3">
          <Link href={isPerson ? "/people" : "/dashboard"}>
            <Button variant="ghost" size="icon" className="mt-0.5 shrink-0" aria-label="Back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              {isPerson ? (
                <Users className="h-4 w-4 text-primary shrink-0" />
              ) : (
                <Sparkles className="h-4 w-4 text-warning-foreground shrink-0" />
              )}
              {collectionLoading ? (
                <Skeleton className="h-7 w-48" />
              ) : (
                <h1 className="text-2xl font-bold text-foreground">{collection?.title}</h1>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {isMemberDriven
                ? isPerson
                  ? `Photos similar to the ${memberCount} tagged to this person`
                  : `Photos similar to the ${memberCount} in this collection`
                : "Photos ranked by visual similarity to the search term"}
            </p>
            {collection?.description && (
              <p className="text-xs text-muted-foreground max-w-xl">{collection.description}</p>
            )}
          </div>
        </div>

        {/* Semantic search term */}
        <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-2" data-testid="smart-term-panel">
          <div className="flex items-center gap-1.5">
            <Sparkles className="h-4 w-4 text-warning-foreground shrink-0" />
            <span className="text-sm font-semibold">Fallback search term</span>
            <span className="text-xs text-muted-foreground">
              {isMemberDriven
                ? "— used only when the collection is empty"
                : "— used until you add photos"}
            </span>
          </div>
          <form onSubmit={handleSaveTerm} className="flex items-end gap-2" data-testid="smart-term-form">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="e.g. shooting"
                value={termInput}
                onChange={(e) => setTermInput(e.target.value)}
                className="h-9 pl-8 text-sm"
                data-testid="smart-term-input"
              />
            </div>
            <Button
              type="submit"
              size="sm"
              className="h-9 gap-1.5 shrink-0"
              disabled={isSaving || termInput.trim() === savedTerm}
              data-testid="save-term-btn"
            >
              {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">
            Add photos to this collection to drive matches from them; otherwise this term (default: the
            title) is used. Photos must be embedded (Admin → Image Embeddings) to appear.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {isLoading ? (
              <Skeleton className="h-4 w-24 inline-block" />
            ) : includeSuggestions ? (
              `${memberPhotos.length} in collection · ${suggestionPhotos.length} suggestion${suggestionPhotos.length !== 1 ? "s" : ""}`
            ) : (
              `${memberPhotos.length} in collection`
            )}
          </p>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none" data-testid="include-suggestions-toggle">
              <Checkbox
                checked={includeSuggestions}
                onCheckedChange={(v) => setIncludeSuggestions(v === true)}
              />
              Include semantic results
            </label>
          <div className="flex items-center gap-2">
            <ArrowUpDown className="h-4 w-4 text-muted-foreground shrink-0" />
            <Select value={sort} onValueChange={(v) => setSort(v as SortOption)}>
              <SelectTrigger className="h-8 w-36 text-sm" data-testid="smart-sort-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="relevance">Best match</SelectItem>
                <SelectItem value="top-rated">Top rated</SelectItem>
                <SelectItem value="newest">Newest first</SelectItem>
                <SelectItem value="oldest">Oldest first</SelectItem>
                <SelectItem value="name-az">Name A–Z</SelectItem>
              </SelectContent>
            </Select>
          </div>
          </div>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[4/3] rounded-lg" />
            ))}
          </div>
        ) : photos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center border-2 border-dashed border-border rounded-xl">
            <Sparkles className="h-10 w-10 text-muted-foreground/30 mb-3" />
            <p className="text-sm font-medium text-foreground mb-1">
              {includeSuggestions ? "No matches yet" : "No photos in this collection yet"}
            </p>
            <p className="text-xs text-muted-foreground max-w-sm">
              {!includeSuggestions
                ? "Turn on “Include semantic results” to see suggested photos, or add photos to the collection."
                : isMemberDriven
                ? "No similar photos found. Make sure your library is embedded (Admin → Image Embeddings)."
                : `Nothing matched “${term}”. Make sure photos are embedded (Admin → Image Embeddings) and try a different term.`}
            </p>
          </div>
        ) : (
          <PhotoGrid
            items={photos}
            getKey={(photo) => photo.id}
            data-testid="smart-collection-photo-grid"
            renderItem={(photo) => {
              const inCollection = collectionPhotoIds.has(photo.id);
              const isAdding = addingIds.has(photo.id);
              return (
                // The tile is a div so the preview button and the per-photo
                // actions are siblings, not nested buttons.
                <div
                  key={photo.id}
                  draggable
                  onDragStart={(e) => startPhotoDrag(e, photo.id)}
                  className="relative w-full h-full rounded-lg overflow-hidden group"
                  data-testid="smart-photo-item"
                  data-photo-id={photo.id}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedPhoto(toLight(photo))}
                    className="absolute inset-0 w-full h-full cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                    aria-label={photoControlLabel("Preview", photo, { extra: inCollection ? "in this collection" : null })}
                    data-testid="smart-photo-preview-btn"
                  >
                    <FadeImage
                      loading="lazy"
                      src={photo.thumbnailKey ? `/api/storage${photo.thumbnailKey}` : photo.url}
                      alt=""
                      className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
                    />
                  </button>

                  {/* Members carry an always-visible check so they read apart
                      from the semantic suggestions in the combined grid. */}
                  {inCollection && (
                    <div
                      className="absolute top-1.5 left-1.5 z-10 flex items-center justify-center rounded-full w-5 h-5 bg-success/90 text-white shadow pointer-events-none"
                      title="In this collection"
                      data-testid="member-badge"
                    >
                      <Check className="h-3 w-3" />
                    </div>
                  )}

                  {/* Cover photo button — top right, always visible when active */}
                  {(() => {
                    const isCover = collection?.coverPhotoId === photo.id;
                    const isSetting = settingCoverId === photo.id;
                    return (
                      <button
                        onClick={(e) => handleSetCover(photo.id, e)}
                        disabled={isSetting || settingCoverId !== null}
                        aria-label={isCover ? "Current cover photo" : "Set as cover photo"}
                        data-testid="set-cover-btn"
                        className={`absolute top-1.5 right-1.5 z-10 flex items-center justify-center rounded-full w-7 h-7 transition-all focus:outline-none focus:ring-2 focus:ring-white/60 ${
                          isCover
                            ? "bg-primary text-primary-foreground shadow-md"
                            : "bg-black/40 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-black/70 backdrop-blur-sm"
                        } ${isSetting ? "opacity-100" : ""}`}
                      >
                        {isSetting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ImageIcon className="h-3.5 w-3.5" />
                        )}
                      </button>
                    );
                  })()}

                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors duration-200 flex items-end p-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-events-none [&>*]:pointer-events-auto">
                    <button
                      onClick={(e) => handleAddPhoto(photo.id, e)}
                      disabled={inCollection || isAdding}
                      aria-label={
                        inCollection
                          ? `Already in ${collection?.title}`
                          : `Add to ${collection?.title}`
                      }
                      data-testid="add-to-collection-btn"
                      className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-white/60 ${
                        inCollection
                          ? "bg-success/90 text-white cursor-default"
                          : "bg-white/20 hover:bg-white/40 text-white backdrop-blur-sm"
                      }`}
                    >
                      {isAdding ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : inCollection ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <Plus className="h-3 w-3" />
                      )}
                      {inCollection ? "In collection" : "Add"}
                    </button>
                    <button
                      onClick={(e) => handleMarkNegative(photo.id, e)}
                      disabled={markingIds.has(photo.id)}
                      aria-label="Not applicable to this collection"
                      data-testid="mark-negative-btn"
                      title="Not this — steer suggestions away from it"
                      className="ml-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium bg-white/20 hover:bg-destructive/80 text-white backdrop-blur-sm transition-colors focus:outline-none focus:ring-2 focus:ring-white/60"
                    >
                      {markingIds.has(photo.id) ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Ban className="h-3 w-3" />
                      )}
                      Not this
                    </button>
                    {photo.averageRating != null && (
                      <div className="flex items-center gap-0.5 ml-auto bg-black/60 rounded px-1.5 py-0.5">
                        <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                        <span className="text-xs text-white font-medium">
                          {photo.averageRating.toFixed(1)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            }}
          />
        )}

        {/* Sentinel: pulls the next page of ranked suggestions into view. */}
        {includeSuggestions && hasNextPage && (
          <div ref={sentinelRef} className="flex justify-center py-4" data-testid="smart-scroll-sentinel">
            {isFetchingNextPage && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
          </div>
        )}

        {negativePhotos && negativePhotos.length > 0 && (
          <div className="space-y-2 pt-2" data-testid="excluded-photos">
            <div className="flex items-center gap-1.5">
              <Ban className="h-4 w-4 text-destructive shrink-0" />
              <span className="text-sm font-semibold text-foreground">Excluded ({negativePhotos.length})</span>
              <span className="text-xs text-muted-foreground">— marked not applicable; suggestions steer away from these</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {negativePhotos.map((p) => (
                <div
                  key={p.id}
                  className="relative h-16 w-16 rounded-lg overflow-hidden border border-destructive/40 bg-muted"
                  data-testid={`excluded-photo-${p.id}`}
                >
                  <img
                    src={p.thumbnailKey ? `/api/storage${p.thumbnailKey}` : p.url}
                    alt=""
                    className="h-full w-full object-cover opacity-70"
                    loading="lazy"
                  />
                  <button
                    type="button"
                    onClick={() => handleUnmarkNegative(p.id)}
                    aria-label={`Un-exclude ${p.filename ?? "photo"}`}
                    data-testid={`unmark-negative-${p.id}`}
                    className="absolute top-0.5 right-0.5 flex items-center justify-center h-5 w-5 rounded-full bg-black/70 text-white hover:bg-black/90"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <PhotoLightbox
        photo={selectedPhoto}
        onClose={() => setSelectedPhoto(null)}
        hasPrev={hasPrev}
        hasNext={hasNext}
        onPrev={() => hasPrev && setSelectedPhoto(toLight(photos[selectedIndex - 1]))}
        onNext={() => hasNext && setSelectedPhoto(toLight(photos[selectedIndex + 1]))}
        onMarkNotApplicable={(photoId) => addNegativeMutation.mutate({ id: collectionId, data: { photoId } })}
        advanceOnRate={false}
      />
    </AppLayout>
  );
}
