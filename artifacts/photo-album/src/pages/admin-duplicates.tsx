import { useState, useEffect } from "react";
import {
  useListDuplicatePhotoGroups,
  getListDuplicatePhotoGroupsQueryKey,
  useGetDuplicatesSummary,
  getGetDuplicatesSummaryQueryKey,
  useDeletePhoto,
  useBulkDeletePhotos,
  useGetMe,
  getGetRecentPhotosQueryKey,
  getGetTopRatedPhotosQueryKey,
} from "@workspace/api-client-react";
import type { DuplicatePhotoGroup } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
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
import { Copy, CheckCircle2, Loader2, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { DuplicatePhotoCard } from "@/components/admin/DuplicatePhotoCard";
import { DuplicatesSection } from "@/components/admin/DuplicatesSection";
import { AdminSectionShell } from "@/components/admin/AdminSectionShell";

const PAGE_SIZE = 20;

// Per group: covers are kept (they can't be deleted), otherwise the first
// (newest) photo is kept. Everything else is a deletable extra.
function groupExtras(group: DuplicatePhotoGroup) {
  const hasCover = group.photos.some((p) => p.isAlbumCover);
  return hasCover ? group.photos.filter((p) => !p.isAlbumCover) : group.photos.slice(1);
}

export default function AdminDuplicatesPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: me } = useGetMe();

  const [offset, setOffset] = useState(0);
  const [allGroups, setAllGroups] = useState<DuplicatePhotoGroup[]>([]);

  const params = { limit: PAGE_SIZE, offset };
  const { data: page, isLoading: pageLoading, isFetching } = useListDuplicatePhotoGroups(params, {
    query: { enabled: !!me && me.role === "admin", queryKey: getListDuplicatePhotoGroupsQueryKey(params) },
  });
  const { data: summary } = useGetDuplicatesSummary({
    query: { enabled: !!me && me.role === "admin", queryKey: getGetDuplicatesSummaryQueryKey() },
  });
  const { mutate: deletePhoto, isPending: isDeleting } = useDeletePhoto();
  const { mutate: bulkDelete, isPending: isBulkDeleting } = useBulkDeletePhotos();

  const hasMore = page?.hasMore ?? false;
  const initialLoading = pageLoading && allGroups.length === 0;

  // Auto-load the next page at the bottom; the button stays as a fallback.
  const sentinelRef = useInfiniteScroll(() => {
    if (!isFetching) setOffset(allGroups.length);
  }, hasMore);

  useEffect(() => {
    if (!page) return;
    if (offset === 0) {
      setAllGroups(page.groups);
    } else {
      setAllGroups((prev) => {
        const seen = new Set(prev.map((g) => g.contentHash));
        return [...prev, ...page.groups.filter((g) => !seen.has(g.contentHash))];
      });
    }
  }, [page, offset]);

  function invalidateCounts() {
    qc.invalidateQueries({ queryKey: getGetDuplicatesSummaryQueryKey() });
    qc.invalidateQueries({ queryKey: ["admin", "photos", "content-hash-backfill-status"] });
    qc.invalidateQueries({ queryKey: getGetRecentPhotosQueryKey() });
    qc.invalidateQueries({ queryKey: getGetTopRatedPhotosQueryKey() });
  }

  // Drop deleted photos from the accumulated groups locally (groups that fall
  // under 2 members disappear) so pagination position is preserved without a
  // full refetch.
  function removePhotosLocally(ids: number[]) {
    const gone = new Set(ids);
    setAllGroups((prev) =>
      prev
        .map((g) => ({ ...g, photos: g.photos.filter((p) => !gone.has(p.id)) }))
        .filter((g) => g.photos.length >= 2),
    );
  }

  function handleDelete(id: number) {
    deletePhoto(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Duplicate deleted" });
          removePhotosLocally([id]);
          invalidateCounts();
        },
        onError: () => toast({ title: "Failed to delete photo", variant: "destructive" }),
      },
    );
  }

  function handleDeleteGroupExtras(group: DuplicatePhotoGroup) {
    const ids = groupExtras(group).map((p) => p.id);
    if (ids.length === 0) return;
    bulkDelete(
      { data: { ids } },
      {
        onSuccess: (result) => {
          toast({ title: `Deleted ${result.deleted} duplicate${result.deleted !== 1 ? "s" : ""}` });
          removePhotosLocally(ids);
          invalidateCounts();
        },
        onError: () => toast({ title: "Bulk delete failed", variant: "destructive" }),
      },
    );
  }

  return (
    <AdminSectionShell
      title="Duplicate Photos"
      icon={Copy}
      description={
        (summary
          ? `${summary.groupCount} group${summary.groupCount !== 1 ? "s" : ""} · ${summary.extraCount} deletable extra${summary.extraCount !== 1 ? "s" : ""}`
          : "…") + " — keep the copy you want and delete the rest. Album covers can't be deleted here."
      }
    >
      <DuplicatesSection showManageLink={false} />
      <div className="space-y-6" data-testid="admin-duplicates-page">
        {initialLoading ? (
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading duplicates…
          </div>
        ) : allGroups.length === 0 ? (
          <div className="flex items-center gap-1.5 text-sm text-success">
            <CheckCircle2 className="h-4 w-4 shrink-0" /> No duplicate photos found
          </div>
        ) : (
          <div className="space-y-5" data-testid="duplicate-groups">
            {allGroups.map((group) => {
              const extras = groupExtras(group);
              return (
                <div key={group.contentHash} className="rounded-lg border border-border p-3 space-y-2" data-testid={`duplicate-group-${group.contentHash}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">
                      {group.photos.length} identical copies
                    </span>
                    <div className="flex items-center gap-2 min-w-0">
                      <code className="text-[10px] text-muted-foreground truncate max-w-[10rem]" title={group.contentHash}>
                        {group.contentHash.slice(0, 16)}…
                      </code>
                      {extras.length > 0 && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={isBulkDeleting}
                              className="h-7 text-xs text-destructive hover:text-destructive shrink-0 gap-1"
                              data-testid={`delete-group-extras-${group.contentHash}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Delete {extras.length} extra{extras.length !== 1 ? "s" : ""}
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete {extras.length} duplicate{extras.length !== 1 ? "s" : ""} from this group?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This keeps {group.photos.length - extras.length} photo{group.photos.length - extras.length !== 1 ? "s" : ""} and
                                permanently deletes the rest, including their stored files. This cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleDeleteGroupExtras(group)}
                                className="bg-destructive hover:bg-destructive/90"
                                data-testid={`confirm-delete-group-extras-${group.contentHash}`}
                              >
                                Delete {extras.length}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {group.photos.map((photo) => (
                      <DuplicatePhotoCard key={photo.id} photo={photo} onDelete={handleDelete} deleting={isDeleting} />
                    ))}
                  </div>
                </div>
              );
            })}

            {hasMore && (
              <div ref={sentinelRef} className="flex justify-center pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setOffset(allGroups.length)}
                  disabled={isFetching}
                  data-testid="load-more-duplicates"
                >
                  {isFetching ? (
                    <span className="flex items-center gap-1.5">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                    </span>
                  ) : (
                    "Load more"
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </AdminSectionShell>
  );
}
