import { useState, useRef, useEffect } from "react";
import { FadeImage } from "@/components/ui/fade-image";
import { PhotoGrid } from "@/components/PhotoGrid";
import { GridZoomControl } from "@/components/GridZoomControl";
import { useGridZoom } from "@/hooks/useGridZoom";
import { startPhotoDrag } from "@/lib/photoDrag";
import { PhotoLightbox, type LightboxPhoto } from "@/components/PhotoLightbox";
import type { Photo } from "@workspace/api-client-react";
import { useParams, Link, useLocation } from "wouter";
import {
  useGetCollection,
  useUpdateCollection,
  useDeleteCollection,
  useListCollections,
  getGetCollectionQueryKey,
  getListCollectionsQueryKey,
  useListCollectionTags,
  useAddCollectionTag,
  useRemoveCollectionTag,
  getListCollectionTagsQueryKey,
  useRemovePhotoFromCollection,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetMe } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { ArrowLeft, FolderOpen, Pencil, Trash2, Star, Tag, X, Plus, ImageIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCapabilities } from "@/hooks/useCapabilities";

function RenameCollectionDialog({
  collectionId,
  currentTitle,
  currentDescription,
  onUpdated,
}: {
  collectionId: number;
  currentTitle: string;
  currentDescription?: string | null;
  onUpdated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(currentTitle);
  const [description, setDescription] = useState(currentDescription ?? "");
  const { mutate: updateCollection, isPending } = useUpdateCollection();
  const { toast } = useToast();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    updateCollection(
      {
        id: collectionId,
        data: {
          title: title.trim(),
          description: description.trim() || null,
        },
      },
      {
        onSuccess: () => {
          setOpen(false);
          onUpdated();
          toast({ title: "Collection updated" });
        },
        onError: () => toast({ title: "Failed to update collection", variant: "destructive" }),
      }
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" data-testid="rename-collection-btn">
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Collection</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="rename-title">Title *</Label>
            <Input
              id="rename-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              data-testid="rename-title-input"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rename-desc">Description</Label>
            <Textarea
              id="rename-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              data-testid="rename-desc-input"
            />
          </div>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || !title.trim()} data-testid="rename-submit">
              {isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TagsSection({
  collectionId,
  canManage,
}: {
  collectionId: number;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [tagInput, setTagInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: tags = [] } = useListCollectionTags(collectionId);
  const { data: allCollections } = useListCollections();
  const { mutate: addTag, isPending: adding } = useAddCollectionTag();
  const { mutate: removeTag } = useRemoveCollectionTag();

  const existingTagsSet = new Set(tags);

  const allKnownTags = Array.from(
    new Set(
      (allCollections ?? []).flatMap((c) => c.tags ?? [])
    )
  ).filter((t) => !existingTagsSet.has(t) && t.includes(tagInput.toLowerCase()));

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function invalidateTags() {
    qc.invalidateQueries({ queryKey: getListCollectionTagsQueryKey(collectionId) });
    qc.invalidateQueries({ queryKey: getListCollectionsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetCollectionQueryKey(collectionId) });
  }

  function handleAddTag(name?: string) {
    const tagName = (name ?? tagInput).trim().toLowerCase();
    if (!tagName) return;
    addTag(
      { id: collectionId, tagName },
      {
        onSuccess: () => {
          setTagInput("");
          setShowSuggestions(false);
          invalidateTags();
        },
        onError: () => toast({ title: "Failed to add tag", variant: "destructive" }),
      }
    );
  }

  function handleRemoveTag(tagName: string) {
    removeTag(
      { id: collectionId, tagName },
      {
        onSuccess: invalidateTags,
        onError: () => toast({ title: "Failed to remove tag", variant: "destructive" }),
      }
    );
  }

  return (
    <div className="space-y-2" data-testid="collection-tags-section">
      <div className="flex items-center gap-1.5">
        <Tag className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-sm font-medium text-muted-foreground">Tags</span>
      </div>
      <div className="flex flex-wrap gap-1.5 min-h-[24px]" data-testid="collection-tags">
        {tags.map((tag) => (
          <Badge key={tag} variant="secondary" className="gap-1 pr-1 text-xs" data-testid={`tag-badge-${tag}`}>
            {tag}
            {canManage && (
              <button
                onClick={() => handleRemoveTag(tag)}
                className="ml-0.5 rounded-sm hover:bg-muted-foreground/20 p-0.5"
                aria-label={`Remove tag ${tag}`}
                data-testid={`remove-tag-${tag}`}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            )}
          </Badge>
        ))}
        {tags.length === 0 && (
          <span className="text-xs text-muted-foreground">No tags yet</span>
        )}
      </div>

      {canManage && (
        <div ref={containerRef} className="relative">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleAddTag();
            }}
            className="flex gap-2"
          >
            <div className="relative flex-1">
              <Input
                value={tagInput}
                onChange={(e) => {
                  setTagInput(e.target.value);
                  setShowSuggestions(true);
                }}
                onFocus={() => setShowSuggestions(true)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setShowSuggestions(false);
                }}
                placeholder="Add tag..."
                className="h-8 text-sm"
                data-testid="add-tag-input"
                autoComplete="off"
              />
              {showSuggestions && tagInput.length > 0 && allKnownTags.length > 0 && (
                <div className="absolute top-full left-0 right-0 z-50 mt-1 rounded-md border border-border bg-popover shadow-md overflow-hidden" data-testid="tag-suggestions">
                  {allKnownTags.slice(0, 6).map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleAddTag(tag);
                      }}
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
                      data-testid={`tag-suggestion-${tag}`}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              className="h-8 px-2"
              disabled={!tagInput.trim() || adding}
              data-testid="add-tag-submit"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}

function toLight(photo: Photo): LightboxPhoto {
  return {
    id: photo.id,
    url: photo.url,
    thumbnailKey: photo.thumbnailKey,
    name: photo.filename,
    averageRating: photo.averageRating,
    albumId: photo.albumId,
  };
}

export default function CollectionDetail() {
  const { id } = useParams<{ id: string }>();
  const collectionId = parseInt(id, 10);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { zoom, setZoom } = useGridZoom();
  const [selectedPhoto, setSelectedPhoto] = useState<LightboxPhoto | null>(null);

  const { data: collection, isLoading } = useGetCollection(collectionId, {
    query: { enabled: !!collectionId, queryKey: getGetCollectionQueryKey(collectionId) },
  });
  const { data: me } = useGetMe();
  const caps = useCapabilities();
  const { mutate: deleteCollection, isPending: deletingCollection } = useDeleteCollection();
  const { mutate: updateCollection } = useUpdateCollection();
  const { mutate: removePhoto } = useRemovePhotoFromCollection();

  function invalidate() {
    qc.invalidateQueries({ queryKey: getGetCollectionQueryKey(collectionId) });
    qc.invalidateQueries({ queryKey: getListCollectionsQueryKey() });
  }

  function handleDeleteCollection() {
    deleteCollection(
      { id: collectionId },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListCollectionsQueryKey() });
          toast({ title: "Collection deleted" });
          navigate("/collections");
        },
        onError: () => toast({ title: "Failed to delete collection", variant: "destructive" }),
      }
    );
  }

  const canManage = !!collection && caps.canManageItem(collection.createdById);

  const photos = collection?.photos ?? [];
  const selectedIndex = selectedPhoto ? photos.findIndex((p) => p.id === selectedPhoto.id) : -1;
  const hasPrev = selectedIndex > 0;
  const hasNext = selectedIndex >= 0 && selectedIndex < photos.length - 1;

  if (isLoading) {
    return (
      <AppLayout>
        <div className="space-y-6">
          <Skeleton className="h-8 w-64" />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[4/3] rounded-lg" />
            ))}
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!collection) {
    return (
      <AppLayout>
        <div className="text-center py-24">
          <p className="text-muted-foreground">Collection not found.</p>
          <Link href="/collections">
            <Button variant="outline" className="mt-4">
              Back to Collections
            </Button>
          </Link>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="collection-detail-page">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <Link href="/collections">
              <Button
                variant="ghost"
                size="icon"
                className="mt-0.5 shrink-0"
                data-testid="back-to-collections"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div className="space-y-1">
              <h1 className="text-2xl font-bold text-foreground" data-testid="collection-title">
                {collection.title}
              </h1>
              <p className="text-sm text-muted-foreground">
                {collection.photoCount} photo{collection.photoCount !== 1 ? "s" : ""}
              </p>
              {collection.description && (
                <p className="text-sm text-muted-foreground max-w-xl">
                  {collection.description}
                </p>
              )}
              <TagsSection collectionId={collectionId} canManage={!!canManage} />
            </div>
          </div>

          {canManage && (
            <div className="flex items-center gap-2 shrink-0">
              <RenameCollectionDialog
                collectionId={collectionId}
                currentTitle={collection.title}
                currentDescription={collection.description}
                onUpdated={invalidate}
              />
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    data-testid="delete-collection-btn"
                    title="Delete collection"
                  >
                    <Trash2 className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this collection?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete "{collection.title}". The photos themselves will
                      not be affected.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDeleteCollection}
                      disabled={deletingCollection}
                      className="bg-destructive hover:bg-destructive/90"
                      data-testid="confirm-delete-collection"
                    >
                      {deletingCollection ? "Deleting…" : "Delete Collection"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </div>

        {!collection.photos || collection.photos.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center py-24 text-center border-2 border-dashed border-border rounded-xl"
            data-testid="no-collection-photos"
          >
            <FolderOpen className="h-10 w-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium text-foreground mb-1">No photos yet</p>
            <p className="text-xs text-muted-foreground mb-4 max-w-sm">
              Open a photo's detail page and add it to this collection from the Collections section.
            </p>
          </div>
        ) : (
          <>
          <div className="flex items-center justify-end">
            <GridZoomControl zoom={zoom} setZoom={setZoom} />
          </div>
          <PhotoGrid
            items={collection.photos}
            getKey={(photo) => photo.id}
            densityOverride={zoom}
            data-testid="collection-photo-grid"
            renderItem={(photo) => {
              const isCover = collection.coverPhotoId === photo.id;
              return (
                <div
                  key={photo.id}
                  draggable
                  onDragStart={(e) => startPhotoDrag(e, photo.id)}
                  className="relative group h-full rounded-lg overflow-hidden bg-muted"
                  data-testid="collection-photo-item"
                >
                  <button
                    type="button"
                    onClick={() => setSelectedPhoto(toLight(photo))}
                    className="block w-full h-full focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
                    aria-label={`Preview ${photo.filename ?? "photo"}`}
                  >
                    <FadeImage
                      loading="lazy"
                      src={photo.thumbnailKey ? `/api/storage${photo.thumbnailKey}` : photo.url}
                      alt={photo.aiDescription ?? "Photo"}
                      className="w-full h-full object-cover cursor-pointer transition-transform duration-200 group-hover:scale-105"
                    />
                  </button>

                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-all duration-200 pointer-events-none" />

                  {photo.averageRating != null && (
                    <div className="absolute top-2 left-2 flex items-center gap-0.5 bg-black/60 rounded px-1.5 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                      <span className="text-xs text-white font-medium">
                        {photo.averageRating.toFixed(1)}
                      </span>
                    </div>
                  )}

                  {isCover && (
                    <div className="absolute top-2 right-2 flex items-center gap-1 bg-primary text-primary-foreground rounded px-1.5 py-0.5 text-[10px] font-medium">
                      <ImageIcon className="h-2.5 w-2.5" />
                      Cover
                    </div>
                  )}

                  {canManage && isCover && (
                    <button
                      type="button"
                      data-testid="clear-cover-btn"
                      onClick={() =>
                        updateCollection(
                          { id: collectionId, data: { coverPhotoId: null } },
                          {
                            onSuccess: () => {
                              invalidate();
                              toast({ title: "Cover photo cleared" });
                            },
                            onError: () =>
                              toast({ title: "Failed to clear cover photo", variant: "destructive" }),
                          }
                        )
                      }
                      className="absolute bottom-2 right-2 flex items-center gap-1 bg-black/70 hover:bg-black/90 text-white rounded px-2 py-1 text-[10px] font-medium opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="h-2.5 w-2.5" />
                      Clear cover
                    </button>
                  )}

                  {canManage && !isCover && (
                    <button
                      type="button"
                      data-testid="set-cover-btn"
                      onClick={() =>
                        updateCollection(
                          { id: collectionId, data: { coverPhotoId: photo.id } },
                          {
                            onSuccess: () => {
                              invalidate();
                              toast({ title: "Cover photo updated" });
                            },
                            onError: () =>
                              toast({ title: "Failed to set cover photo", variant: "destructive" }),
                          }
                        )
                      }
                      className="absolute bottom-2 right-2 flex items-center gap-1 bg-black/70 hover:bg-black/90 text-white rounded px-2 py-1 text-[10px] font-medium opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <ImageIcon className="h-2.5 w-2.5" />
                      Set as cover
                    </button>
                  )}

                  {canManage && (
                    <button
                      type="button"
                      data-testid="remove-from-collection-btn"
                      onClick={() =>
                        removePhoto(
                          { id: collectionId, photoId: photo.id },
                          {
                            onSuccess: () => {
                              invalidate();
                              toast({ title: "Photo removed from collection" });
                            },
                            onError: () =>
                              toast({ title: "Failed to remove photo", variant: "destructive" }),
                          }
                        )
                      }
                      className="absolute bottom-2 left-2 flex items-center gap-1 bg-black/70 hover:bg-red-600 text-white rounded px-2 py-1 text-[10px] font-medium opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="h-2.5 w-2.5" />
                      Remove
                    </button>
                  )}
                </div>
              );
            }}
          />
          </>
        )}
      </div>

      <PhotoLightbox
        photo={selectedPhoto}
        onClose={() => setSelectedPhoto(null)}
        hasPrev={hasPrev}
        hasNext={hasNext}
        onPrev={() => hasPrev && setSelectedPhoto(toLight(photos[selectedIndex - 1]))}
        onNext={() => hasNext && setSelectedPhoto(toLight(photos[selectedIndex + 1]))}
      />
    </AppLayout>
  );
}
