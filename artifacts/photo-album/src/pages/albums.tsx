import { useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { FadeImage } from "@/components/ui/fade-image";
import { useListAlbums, useCreateAlbum, useReorderAlbums, useUpdateAlbum, getListAlbumsQueryKey, type Album } from "@workspace/api-client-react";
import { useCardReorder } from "@/hooks/useCardReorder";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2 } from "lucide-react";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus, Images, CalendarDays, Camera, EyeOff, Upload, Star, Folder, FolderPlus } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useGetMe } from "@workspace/api-client-react";
import { formatDate } from "@/lib/format-date";
import { collectFolders, FolderCard, FolderBreadcrumb } from "@/components/FolderBrowser";

type AlbumItem = Album;

// The generic folder helper lives in FolderBrowser; re-export so EditAlbumDialog
// (which imports it from here) keeps working.
export { collectFolders };

function CreateAlbumDialog({ onCreated, folderSuggestions }: { onCreated: () => void; folderSuggestions: string[] }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [folder, setFolder] = useState("");
  const { mutate: createAlbum, isPending } = useCreateAlbum();
  const { toast } = useToast();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    createAlbum(
      {
        data: {
          title: title.trim(),
          description: description.trim() || undefined,
          eventDate: eventDate || undefined,
          folder: folder.trim() || undefined,
        },
      },
      {
        onSuccess: () => {
          setOpen(false);
          setTitle("");
          setDescription("");
          setEventDate("");
          setFolder("");
          onCreated();
          toast({ title: "Album created", description: `"${title}" is ready.` });
        },
        onError: () => toast({ title: "Failed to create album", variant: "destructive" }),
      }
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2" data-testid="create-album-btn">
          <Plus className="h-4 w-4" />
          New Album
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Album</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="album-title">Title *</Label>
            <Input
              id="album-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Summer Offsite 2025"
              required
              data-testid="album-title-input"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="album-desc">Description</Label>
            <Textarea
              id="album-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A brief description of this album..."
              rows={3}
              data-testid="album-desc-input"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="album-date">Event Date</Label>
            <Input
              id="album-date"
              type="date"
              value={eventDate}
              onChange={(e) => setEventDate(e.target.value)}
              data-testid="album-date-input"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="album-folder">Folder</Label>
            <Input
              id="album-folder"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder='Optional — e.g. "2026"'
              list="album-folder-options"
              data-testid="album-folder-input"
            />
            <datalist id="album-folder-options">
              {folderSuggestions.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </div>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={isPending || !title.trim()} data-testid="create-album-submit">
              {isPending ? "Creating..." : "Create Album"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Folder-first creation (#161): name a folder and pick which albums go in it,
// setting each album's folder in one step — so a folder is never an empty
// album-shaped thing. Implicit folders can't be empty, so ≥1 album is required.
function NewFolderDialog({
  albums,
  folderSuggestions,
  onCreated,
}: {
  albums: AlbumItem[];
  folderSuggestions: string[];
  onCreated: (folder: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const { mutateAsync: updateAlbum } = useUpdateAlbum();
  const { toast } = useToast();

  function resetState() {
    setName("");
    setFilter("");
    setSelected(new Set());
  }

  const filtered = albums.filter((a) => a.title.toLowerCase().includes(filter.trim().toLowerCase()));

  function toggle(id: number) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const folder = name.trim();
    if (!folder || selected.size === 0 || saving) return;
    setSaving(true);
    let ok = 0;
    let fail = 0;
    for (const id of selected) {
      try {
        await updateAlbum({ id, data: { folder } });
        ok++;
      } catch {
        fail++;
      }
    }
    setSaving(false);
    setOpen(false);
    resetState();
    if (fail > 0) {
      toast({
        title: `Added ${ok} album${ok !== 1 ? "s" : ""}, ${fail} failed`,
        description: "Only an album's owner or a platform admin can move it.",
        variant: "destructive",
      });
    } else {
      toast({ title: `Folder "${folder}" created`, description: `${ok} album${ok !== 1 ? "s" : ""} added.` });
    }
    if (ok > 0) onCreated(folder);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) resetState(); }}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2" data-testid="new-folder-btn">
          <FolderPlus className="h-4 w-4" />
          New Folder
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="new-folder-name">Folder name</Label>
            <Input
              id="new-folder-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='e.g. "2026"'
              list="new-folder-options"
              autoFocus
              data-testid="new-folder-name"
            />
            <datalist id="new-folder-options">
              {folderSuggestions.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1.5">
            <Label>Albums in this folder</Label>
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter albums…"
              className="h-8"
              data-testid="new-folder-filter"
            />
            <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
              {filtered.length === 0 ? (
                <p className="px-3 py-4 text-center text-sm text-muted-foreground">No albums</p>
              ) : (
                filtered.map((a) => (
                  <label key={a.id} className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-accent/50">
                    <Checkbox
                      checked={selected.has(a.id)}
                      onCheckedChange={() => toggle(a.id)}
                      data-testid={`new-folder-album-${a.id}`}
                    />
                    <span className="flex-1 truncate text-sm text-foreground">{a.title}</span>
                    {a.folder && <span className="text-xs text-muted-foreground">in {a.folder}</span>}
                  </label>
                ))
              )}
            </div>
            <p className="text-xs text-muted-foreground">{selected.size} selected</p>
          </div>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={saving || !name.trim() || selected.size === 0} data-testid="new-folder-submit">
              {saving ? "Creating…" : "Create folder"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// How many album cards to reveal per "page" as the user scrolls (3 rows of the
// 4-column grid). Windowing only applies to the single-flat-list view; once
// folders exist the page renders grouped sections in full (cover images are
// still lazy-loaded).
const ALBUMS_PAGE_SIZE = 12;

// One reorderable grid of album cards. Sections each get their own instance so
// drag-to-reorder works within a folder; onCommit receives the section's new
// id order and the parent stitches the full flat order.
function AlbumGrid({
  albums,
  isAdmin,
  onCommit,
  onMove,
  testId,
}: {
  albums: AlbumItem[];
  isAdmin: boolean;
  onCommit: (orderedIds: number[]) => void;
  onMove: (album: AlbumItem) => void;
  testId?: string;
}) {
  const reorder = useCardReorder({
    ids: albums.map((a) => a.id),
    onCommit,
  });

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4" data-testid={testId ?? "albums-grid"}>
      {reorder.arrange(albums, (a) => a.id).map((album) => (
        <Link key={album.id} href={`/albums/${album.id}`} {...reorder.handlers(album.id)}>
          <div className={`relative rounded-xl overflow-hidden border border-border bg-card group cursor-pointer hover:shadow-md transition-shadow${reorder.draggingId === album.id ? " opacity-50" : ""}`} data-testid="album-card">
            {/* Quick "move to folder" without opening the album (#149). Stops
                the click so the card's Link doesn't navigate. */}
            <button
              type="button"
              className="absolute right-2 top-2 z-10 rounded-md bg-background/80 p-1.5 text-muted-foreground opacity-0 shadow-sm backdrop-blur transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
              title="Move to folder"
              aria-label={`Move "${album.title}" to a folder`}
              data-testid={`move-album-${album.id}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onMove(album);
              }}
              draggable={false}
            >
              <Folder className="h-3.5 w-3.5" />
            </button>
            <div className="aspect-[4/3] bg-muted overflow-hidden">
              {album.coverPhotoUrl ? (
                <FadeImage
                  src={album.coverPhotoThumbnailKey ? `/api/storage${album.coverPhotoThumbnailKey}` : album.coverPhotoUrl}
                  alt={album.title}
                  loading="lazy"
                  className="h-full w-full object-cover group-hover:scale-105 transition-transform duration-200"
                />
              ) : (
                <div className="h-full w-full flex items-center justify-center text-muted-foreground/40">
                  <Images className="h-10 w-10" />
                </div>
              )}
            </div>
            <div className="p-3">
              <p className="font-medium text-foreground text-sm truncate">{album.title}</p>
              {/* Phones show half-width cards, so the stats stack one per
                  line there; two columns only from sm up. */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1 mt-1.5 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1 whitespace-nowrap">
                  <Camera className="h-3 w-3 shrink-0" />
                  {album.photoCount} photo{album.photoCount !== 1 ? "s" : ""}
                </span>
                {album.photoCount > 0 && (
                  <span className="flex items-center gap-1 whitespace-nowrap">
                    <Star className="h-3 w-3 shrink-0" />
                    {album.ratedCount}/{album.photoCount} rated
                  </span>
                )}
                {isAdmin && !!album.hiddenCount && (
                  <span className="flex items-center gap-0.5 whitespace-nowrap text-muted-foreground/70">
                    <EyeOff className="h-3 w-3 shrink-0" />
                    {album.hiddenCount} hidden
                  </span>
                )}
                {album.eventDate && (
                  <span className="flex items-center gap-1 whitespace-nowrap">
                    <CalendarDays className="h-3 w-3 shrink-0" />
                    {formatDate(album.eventDate)}
                  </span>
                )}
              </div>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

export default function Albums() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const search = useSearch();
  const { data: albums, isLoading } = useListAlbums();
  const { data: me } = useGetMe();
  const [visibleCount, setVisibleCount] = useState(ALBUMS_PAGE_SIZE);
  const isAdmin = me?.role === "admin";

  const folders = collectFolders(albums);
  // Drill-down (#158): ?folder=X shows just that folder; no param shows the
  // folder index (cards) plus any ungrouped albums.
  const activeFolder = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("folder");
  const ungrouped = (albums ?? []).filter((a) => !a.folder);
  const inFolder = activeFolder != null ? (albums ?? []).filter((a) => a.folder === activeFolder) : [];

  // Up to 4 cover thumbnails for a folder's index tile.
  function folderCovers(name: string): string[] {
    return (albums ?? [])
      .filter((a) => a.folder === name)
      .map((a) => (a.coverPhotoThumbnailKey ? `/api/storage${a.coverPhotoThumbnailKey}` : a.coverPhotoUrl))
      .filter((u): u is string => !!u)
      .slice(0, 4);
  }

  // Flat-view windowing only when there are no folders at all.
  const flatView = folders.length === 0;
  const totalAlbums = albums?.length ?? 0;
  const visibleAlbums = flatView ? (albums?.slice(0, visibleCount) ?? []) : [];
  const hasMore = flatView && totalAlbums > visibleCount;
  const sentinelRef = useInfiniteScroll(
    () => setVisibleCount((c) => c + ALBUMS_PAGE_SIZE),
    hasMore,
  );

  function refetch() {
    qc.invalidateQueries({ queryKey: getListAlbumsQueryKey() });
  }

  const reorderMutation = useReorderAlbums();
  const { toast } = useToast();

  // "Move to folder" quick action from a card (#149). moveAlbum is the album
  // being moved; the dialog seeds its input from the album's current folder.
  const [moveAlbum, setMoveAlbum] = useState<AlbumItem | null>(null);
  const [moveFolder, setMoveFolder] = useState("");
  const { mutate: updateAlbum, isPending: isMoving } = useUpdateAlbum();

  function openMove(album: AlbumItem) {
    setMoveAlbum(album);
    setMoveFolder(album.folder ?? "");
  }

  function handleMoveSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!moveAlbum) return;
    const target = moveFolder.trim() || null;
    updateAlbum(
      { id: moveAlbum.id, data: { folder: target } },
      {
        onSuccess: () => {
          setMoveAlbum(null);
          refetch();
          toast({
            title: target ? `Moved to "${target}"` : "Removed from folder",
            description: `"${moveAlbum.title}"`,
          });
        },
        // PATCH /albums/:id is owner-or-platform-admin; surface the 403 plainly.
        onError: () => toast({ title: "Failed to move album", description: "Only the album's owner or a platform admin can move it.", variant: "destructive" }),
      },
    );
  }

  // Persist a reordered subset (a folder's albums, or the ungrouped grid),
  // slotting its new order into place and keeping every other album fixed.
  function commitOrder(orderedIds: number[]) {
    const idSet = new Set(orderedIds);
    let qi = 0;
    const result = (albums ?? []).map((a) => (idSet.has(a.id) ? orderedIds[qi++] : a.id));
    reorderMutation.mutate({ data: { ids: result } }, { onSuccess: refetch });
  }

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="albums-page">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Albums</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {albums?.length ?? 0} album{albums?.length !== 1 ? "s" : ""} ready to review
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" className="gap-2" onClick={() => navigate("/bulk-upload")} data-testid="bulk-upload-btn">
              <Upload className="h-4 w-4" />
              Upload
            </Button>
            {(albums?.length ?? 0) > 0 && activeFolder == null && (
              <NewFolderDialog
                albums={albums ?? []}
                folderSuggestions={folders}
                onCreated={(f) => { refetch(); navigate(`/albums?folder=${encodeURIComponent(f)}`); }}
              />
            )}
            <CreateAlbumDialog onCreated={refetch} folderSuggestions={folders} />
          </div>
        </div>

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
        ) : albums && albums.length > 0 ? (
          activeFolder != null ? (
            // Drilled into a folder.
            <div className="space-y-4">
              <FolderBreadcrumb rootHref="/albums" rootLabel="Albums" folder={activeFolder} />
              {inFolder.length > 0 ? (
                <AlbumGrid albums={inFolder} isAdmin={isAdmin} onCommit={commitOrder} onMove={openMove} />
              ) : (
                <p className="text-sm text-muted-foreground">This folder is empty.</p>
              )}
            </div>
          ) : folders.length > 0 ? (
            // Folder index: folder tiles, then any ungrouped albums.
            <div className="space-y-8">
              <div>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Folders</h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                  {folders.map((f) => (
                    <FolderCard
                      key={f}
                      name={f}
                      count={(albums ?? []).filter((a) => a.folder === f).length}
                      covers={folderCovers(f)}
                      href={`/albums?folder=${encodeURIComponent(f)}`}
                    />
                  ))}
                </div>
              </div>
              {ungrouped.length > 0 && (
                <div>
                  <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Ungrouped</h2>
                  <AlbumGrid albums={ungrouped} isAdmin={isAdmin} onCommit={commitOrder} onMove={openMove} testId="albums-grid" />
                </div>
              )}
            </div>
          ) : (
            // No folders anywhere — flat, windowed list.
            <>
              <AlbumGrid albums={visibleAlbums} isAdmin={isAdmin} onCommit={commitOrder} onMove={openMove} testId="albums-grid" />
              {hasMore && (
                <div
                  ref={sentinelRef}
                  className="flex items-center justify-center py-8 text-sm text-muted-foreground"
                  data-testid="albums-load-more"
                >
                  <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading more albums…
                </div>
              )}
            </>
          )
        ) : (
          <div className="flex flex-col items-center justify-center py-24 text-center" data-testid="albums-empty">
            <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center mb-4">
              <Images className="h-7 w-7 text-muted-foreground" />
            </div>
            <h3 className="text-base font-medium text-foreground mb-1">No albums yet</h3>
            <p className="text-sm text-muted-foreground max-w-sm mb-6">
              Create your first album to start gathering photos for the team to review.
            </p>
            <CreateAlbumDialog onCreated={refetch} folderSuggestions={folders} />
          </div>
        )}

        {/* Move-to-folder dialog for the card quick action. */}
        <Dialog open={moveAlbum !== null} onOpenChange={(open) => { if (!open) setMoveAlbum(null); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Move to folder</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleMoveSubmit} className="space-y-4 pt-2">
              <div className="space-y-1.5">
                <Label htmlFor="move-album-folder">
                  Folder for <span className="font-medium">{moveAlbum?.title}</span>
                </Label>
                <Input
                  id="move-album-folder"
                  value={moveFolder}
                  onChange={(e) => setMoveFolder(e.target.value)}
                  placeholder='e.g. "2026" — leave empty to ungroup'
                  list="move-album-folder-options"
                  autoFocus
                  data-testid="move-album-folder-input"
                />
                <datalist id="move-album-folder-options">
                  {folders.map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
              </div>
              <div className="flex justify-end gap-3">
                <Button type="button" variant="outline" onClick={() => setMoveAlbum(null)}>Cancel</Button>
                <Button type="submit" disabled={isMoving} data-testid="move-album-submit">
                  {isMoving ? "Moving..." : "Move"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}
