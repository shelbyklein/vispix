import { useState } from "react";
import { Link } from "wouter";
import { FadeImage } from "@/components/ui/fade-image";
import {
  useListCollections,
  useCreateCollection,
  useUpdateCollection,
  useReorderCollections,
  getListCollectionsQueryKey,
} from "@workspace/api-client-react";
import { useCardReorder } from "@/hooks/useCardReorder";
import { useQueryClient } from "@tanstack/react-query";
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
import { Plus, FolderOpen, Camera, Tag, X, Pencil } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useGetMe } from "@workspace/api-client-react";
import { useCapabilities } from "@/hooks/useCapabilities";

function CreateCollectionDialog({ onCreated, testId = "create-collection-btn" }: { onCreated: () => void; testId?: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const { mutate: createCollection, isPending } = useCreateCollection();
  const { toast } = useToast();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    createCollection(
      { data: { title: title.trim(), description: description.trim() || undefined } },
      {
        onSuccess: () => {
          setOpen(false);
          setTitle("");
          setDescription("");
          onCreated();
          toast({ title: "Collection created", description: `"${title}" is ready.` });
        },
        onError: () => toast({ title: "Failed to create collection", variant: "destructive" }),
      }
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2" data-testid={testId}>
          <Plus className="h-4 w-4" />
          New Collection
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Collection</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="collection-title">Title *</Label>
            <Input
              id="collection-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Youth Division"
              required
              data-testid="collection-title-input"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="collection-desc">Description</Label>
            <Textarea
              id="collection-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A brief description of this collection..."
              rows={3}
              data-testid="collection-desc-input"
            />
          </div>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isPending || !title.trim()}
              data-testid="create-collection-submit"
            >
              {isPending ? "Creating..." : "Create Collection"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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

  function handleOpen(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setTitle(currentTitle);
    setDescription(currentDescription ?? "");
    setOpen(true);
  }

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
          toast({ title: "Collection renamed" });
        },
        onError: () => toast({ title: "Failed to rename collection", variant: "destructive" }),
      }
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          onClick={handleOpen}
          className="absolute top-2 right-2 z-10 flex items-center justify-center h-7 w-7 rounded-full bg-black/60 hover:bg-black/80 text-white opacity-0 group-hover:opacity-100 transition-opacity"
          aria-label="Rename collection"
          data-testid="rename-collection-card-btn"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename Collection</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="rename-card-title">Title *</Label>
            <Input
              id="rename-card-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              autoFocus
              data-testid="rename-card-title-input"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rename-card-desc">Description</Label>
            <Textarea
              id="rename-card-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              data-testid="rename-card-desc-input"
            />
          </div>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || !title.trim()} data-testid="rename-card-submit">
              {isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function Collections() {
  const qc = useQueryClient();
  const { data: collections, isLoading } = useListCollections();
  const { data: me } = useGetMe();
  const caps = useCapabilities();
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const allTags = Array.from(
    new Set(
      (collections ?? []).flatMap((c) => c.tags ?? [])
    )
  ).sort();

  const filtered = activeTag
    ? (collections ?? []).filter((c) =>
        (c.tags ?? []).includes(activeTag)
      )
    : collections;

  const reorderMutation = useReorderCollections();
  const reorder = useCardReorder({
    ids: (filtered ?? []).map((c) => c.id),
    // Reordering a tag-filtered subset is ambiguous — drag only on the full list.
    disabled: !!activeTag,
    onCommit: (orderedIds) =>
      reorderMutation.mutate(
        { data: { ids: orderedIds } },
        { onSuccess: () => qc.invalidateQueries({ queryKey: getListCollectionsQueryKey() }) },
      ),
  });

  function refetch() {
    qc.invalidateQueries({ queryKey: getListCollectionsQueryKey() });
  }

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="collections-page">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Collections</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {collections?.length ?? 0} collection{collections?.length !== 1 ? "s" : ""} — group photos across albums by subject or context
            </p>
          </div>
          <CreateCollectionDialog onCreated={refetch} />
        </div>

        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 items-center" data-testid="tag-filter">
            <Tag className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground mr-1">Filter:</span>
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border transition-colors ${
                  activeTag === tag
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
                }`}
                data-testid={`tag-filter-${tag}`}
              >
                {tag}
                {activeTag === tag && <X className="h-2.5 w-2.5" />}
              </button>
            ))}
          </div>
        )}

        {isLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="rounded-xl overflow-hidden border border-border">
                <Skeleton className="aspect-[4/3] w-full" />
                <div className="p-3 space-y-1.5">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered && filtered.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4" data-testid="collections-grid">
            {reorder.arrange(filtered, (c) => c.id).map((collection) => {
              const tags = collection.tags ?? [];
              const canManage = caps.canManageItem(collection.createdById);
              return (
                <div
                  key={collection.id}
                  className={`relative group${reorder.draggingId === collection.id ? " opacity-50" : ""}`}
                  {...reorder.handlers(collection.id)}
                >
                  {canManage && (
                    <RenameCollectionDialog
                      collectionId={collection.id}
                      currentTitle={collection.title}
                      currentDescription={collection.description}
                      onUpdated={refetch}
                    />
                  )}
                  <Link href={`/collections/${collection.id}`}>
                    <div
                      className="rounded-xl overflow-hidden border border-border bg-card cursor-pointer hover:shadow-md transition-shadow"
                      data-testid="collection-card"
                    >
                      <div className="aspect-[4/3] bg-muted overflow-hidden">
                        {collection.coverPhotoUrl ? (
                          <FadeImage
                            src={collection.coverPhotoThumbnailKey ? `/api/storage${collection.coverPhotoThumbnailKey}` : collection.coverPhotoUrl}
                            alt={collection.title}
                            className="h-full w-full object-cover group-hover:scale-105 transition-transform duration-200"
                          />
                        ) : (
                          <div className="h-full w-full flex items-center justify-center text-muted-foreground/40">
                            <FolderOpen className="h-10 w-10" />
                          </div>
                        )}
                      </div>
                      <div className="p-3">
                        <p className="font-medium text-foreground text-sm truncate">{collection.title}</p>
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Camera className="h-3 w-3" />
                            {collection.photoCount} photo{collection.photoCount !== 1 ? "s" : ""}
                          </span>
                        </div>
                        {collection.description && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                            {collection.description}
                          </p>
                        )}
                        {tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {tags.slice(0, 3).map((tag) => (
                              <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                                {tag}
                              </Badge>
                            ))}
                            {tags.length > 3 && (
                              <span className="text-[10px] text-muted-foreground">+{tags.length - 3}</span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </Link>
                </div>
              );
            })}
          </div>
        ) : (
          <div
            className="flex flex-col items-center justify-center py-24 text-center"
            data-testid="collections-empty"
          >
            <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center mb-4">
              <FolderOpen className="h-7 w-7 text-muted-foreground" />
            </div>
            <h3 className="text-base font-medium text-foreground mb-1">
              {activeTag ? `No collections tagged "${activeTag}"` : "No collections yet"}
            </h3>
            <p className="text-sm text-muted-foreground max-w-sm mb-6">
              {activeTag
                ? "Try a different tag filter or clear the filter to see all collections."
                : "Create a collection to group photos by subject or context across multiple albums."}
            </p>
            {activeTag ? (
              <Button variant="outline" size="sm" onClick={() => setActiveTag(null)}>
                Clear filter
              </Button>
            ) : (
              <CreateCollectionDialog onCreated={refetch} testId="create-collection-btn-empty" />
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
