import { useState, useEffect } from "react";
import {
  useNearDuplicatePhotoGroups,
  getNearDuplicatePhotoGroupsQueryKey,
  usePerceptualHashBackfillStatus,
  useBackfillPerceptualHashes,
  useNearDuplicateIndexStatus,
  useRebuildNearDuplicateIndex,
  useIgnoreNearDuplicates,
  useNearDuplicateExtrasSummary,
  useDeleteNearDuplicateExtras,
  useDeletePhoto,
  useBulkDeletePhotos,
  getGetRecentPhotosQueryKey,
  getGetTopRatedPhotosQueryKey,
} from "@workspace/api-client-react";
import type { NearDuplicateGroup } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AdminSectionShell } from "@/components/admin/AdminSectionShell";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { CopyCheck, CheckCircle2, Loader2, Trash2, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { cn } from "@/lib/utils";
import { DuplicatePhotoCard } from "@/components/admin/DuplicatePhotoCard";
import { NearDuplicateCleanupModal } from "@/components/admin/NearDuplicateCleanupModal";

type BackfillResult = {
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
};

// Hamming-distance presets. Lower = stricter (only very close matches); higher
// catches heavier re-encodes/crops at the cost of more false positives.
const THRESHOLD_OPTIONS: { value: number; label: string; hint: string }[] = [
  { value: 4, label: "Strict", hint: "near-identical" },
  { value: 6, label: "Balanced", hint: "re-encoded / resized" },
  { value: 10, label: "Loose", hint: "aggressive — more, looser matches" },
];

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

export default function AdminNearDuplicatesPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [threshold, setThreshold] = useState<number>(6);
  const [pageSize, setPageSize] = useState<number>(20);
  const [offset, setOffset] = useState(0);
  const [allGroups, setAllGroups] = useState<NearDuplicateGroup[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [lastBackfill, setLastBackfill] = useState<BackfillResult | null>(null);

  const { data: statusData, isLoading: isStatusLoading } = usePerceptualHashBackfillStatus();
  const { mutate: backfill, isPending: isBackfilling } = useBackfillPerceptualHashes();
  const { data: indexStatus } = useNearDuplicateIndexStatus();
  const { mutate: rebuildIndex, isPending: isRebuilding } = useRebuildNearDuplicateIndex();
  const params = { threshold, limit: pageSize, offset };
  const { data: page, isLoading: pageLoading, isFetching } = useNearDuplicatePhotoGroups(params);
  const { mutate: deletePhoto, isPending: isDeleting } = useDeletePhoto();
  const { mutate: bulkDelete, isPending: isBulkDeleting } = useBulkDeletePhotos();
  const { mutate: ignoreGroupPhotos, isPending: isIgnoring } = useIgnoreNearDuplicates();
  const { data: extrasSummary } = useNearDuplicateExtrasSummary(threshold);
  const { mutate: deleteExtras, isPending: isDeletingExtras } = useDeleteNearDuplicateExtras();
  const [cleanupOpen, setCleanupOpen] = useState(false);

  const missingCount = statusData?.missingCount ?? null;
  const totalGroups = page?.totalGroups ?? null;
  const hasMore = page?.hasMore ?? false;
  const initialLoading = pageLoading && allGroups.length === 0;

  // Auto-load the next page at the bottom; the button stays as a fallback.
  const sentinelRef = useInfiniteScroll(() => {
    if (!isFetching) setOffset(allGroups.length);
  }, hasMore);

  // Changing sensitivity or page size restarts the list (and the selection —
  // selected photos may no longer be on screen).
  function resetList() {
    setOffset(0);
    setAllGroups([]);
    setSelected(new Set());
  }

  useEffect(() => {
    if (!page) return;
    if (offset === 0) {
      setAllGroups(page.groups);
    } else {
      setAllGroups((prev) => {
        const seen = new Set(prev.map((g) => g.key));
        return [...prev, ...page.groups.filter((g) => !seen.has(g.key))];
      });
    }
  }, [page, offset]);

  function invalidateAfterDelete() {
    qc.invalidateQueries({ queryKey: ["admin", "photos", "near-duplicates"] });
    qc.invalidateQueries({ queryKey: getGetRecentPhotosQueryKey() });
    qc.invalidateQueries({ queryKey: getGetTopRatedPhotosQueryKey() });
  }

  // Remove deleted photos from the accumulated groups locally (groups falling
  // under 2 photos disappear) so the scroll/paging position is preserved.
  function removePhotosLocally(ids: number[]) {
    const gone = new Set(ids);
    setAllGroups((prev) =>
      prev
        .map((g) => ({ ...g, photos: g.photos.filter((p) => !gone.has(p.id)) }))
        .filter((g) => g.photos.length >= 2),
    );
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }

  function toggleSelected(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleDelete(id: number) {
    deletePhoto(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Photo deleted" });
          removePhotosLocally([id]);
          invalidateAfterDelete();
        },
        onError: () => toast({ title: "Failed to delete photo", variant: "destructive" }),
      },
    );
  }

  function handleDeleteSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    bulkDelete(
      { data: { ids } },
      {
        onSuccess: (result) => {
          toast({ title: `Deleted ${result.deleted} photo${result.deleted !== 1 ? "s" : ""}` });
          removePhotosLocally(ids);
          invalidateAfterDelete();
        },
        onError: () => toast({ title: "Bulk delete failed", variant: "destructive" }),
      },
    );
  }

  // One-click "delete a match of every group at this sensitivity" (#177/#179):
  // removes one copy of each group over the selected similarity threshold
  // library-wide, keeping covers / one per group.
  function handleDeleteExtras() {
    deleteExtras(threshold, {
      onSuccess: (result) => {
        toast({
          title: `Deleted ${result.deleted} photo${result.deleted !== 1 ? "s" : ""}`,
        });
        resetList();
        invalidateAfterDelete();
      },
      onError: () => toast({ title: "Failed to delete matches", variant: "destructive" }),
    });
  }

  // Dismiss a comparison as not-duplicates (#124): persisted server-side so the
  // group never resurfaces; removed locally so the modal advances immediately.
  function handleIgnoreGroup(group: NearDuplicateGroup) {
    ignoreGroupPhotos(
      group.photos.map((p) => p.id),
      {
        onSuccess: () => {
          toast({ title: "Comparison ignored", description: "These photos won't be flagged as near-duplicates again." });
          setAllGroups((prev) => prev.filter((g) => g.key !== group.key));
        },
        onError: () => toast({ title: "Failed to ignore the comparison", variant: "destructive" }),
      },
    );
  }

  function handleBackfill() {
    setLastBackfill(null);
    backfill(undefined, {
      onSuccess: (result) => {
        setLastBackfill(result);
        if (result.processed === 0) {
          toast({ title: "All photos already have a perceptual hash" });
        } else if (result.failed === 0) {
          toast({ title: `Hashed ${result.updated} photo${result.updated !== 1 ? "s" : ""}` });
        } else {
          toast({
            title: "Perceptual hashing completed with some errors",
            description: `${result.updated} hashed, ${result.failed} failed`,
            variant: "destructive",
          });
        }
        resetList();
      },
      onError: () => toast({ title: "Perceptual hashing failed", variant: "destructive" }),
    });
  }

  function handleRebuildIndex() {
    rebuildIndex(undefined, {
      onSuccess: (r) => {
        toast({ title: `Index rebuilt — ${r.pairs} near-duplicate pair${r.pairs !== 1 ? "s" : ""} from ${r.photos} photos` });
        resetList();
      },
      onError: () => toast({ title: "Failed to rebuild index", variant: "destructive" }),
    });
  }

  const pairCount = indexStatus?.pairCount ?? null;
  const needsIndex = indexStatus != null && indexStatus.pairCount === 0 && indexStatus.hashedPhotos >= 2;

  // Lowest similarity swept by the current sensitivity (0 bits = 100%), shown on
  // the bulk "delete all matches over X%" action (#179).
  const minSimilarity = Math.round(((64 - threshold) / 64) * 100);
  const extrasCount = extrasSummary?.extraCount ?? 0;

  return (
    <AdminSectionShell
      title="Near-Duplicate Photos"
      icon={CopyCheck}
      description="Visually near-identical photos — re-encoded, resized or lightly edited copies. Select the ones to remove, then delete them together."
    >
      {/* Perceptual-hash backfill: hashes must exist before matching can run. */}
      <div className="rounded-lg border border-border bg-background/40 px-4 py-3 space-y-3">
        <p className="text-xs text-muted-foreground">
          Near-duplicate detection compares each photo's perceptual hash. Photos uploaded before this was added
          need their hash computed once.
        </p>
        <div className="text-sm" data-testid="perceptual-hash-status">
          {isStatusLoading ? (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…
            </span>
          ) : missingCount === 0 ? (
            <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4 shrink-0" /> All photos have a perceptual hash
            </span>
          ) : missingCount !== null ? (
            <span className="text-amber-700 dark:text-amber-400 font-medium">
              {missingCount} photo{missingCount !== 1 ? "s" : ""} not yet hashed
            </span>
          ) : null}
        </div>
        {lastBackfill && lastBackfill.processed > 0 && (
          <div className="text-xs text-muted-foreground">
            Hashed {lastBackfill.updated}, skipped {lastBackfill.skipped}, failed {lastBackfill.failed}
          </div>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleBackfill}
          disabled={isBackfilling}
          data-testid="backfill-perceptual-hashes-btn"
        >
          <CopyCheck className="h-4 w-4 mr-2" />
          {isBackfilling ? "Computing hashes…" : "Compute missing hashes"}
        </Button>
      </div>

      {/* Stored match index: matches are precomputed and saved so the page
          reads them instead of rescanning the library on every visit. */}
      <div className="rounded-lg border border-border bg-background/40 px-4 py-3 space-y-3">
        <p className="text-xs text-muted-foreground">
          Near-duplicate matches are stored in the database and kept up to date as photos are added.
          Rebuild the index once for a library that was hashed before this was added, or to force a full recompute.
        </p>
        <div className="text-sm" data-testid="near-dup-index-status">
          {pairCount === null ? (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…
            </span>
          ) : needsIndex ? (
            <span className="text-amber-700 dark:text-amber-400 font-medium">
              Index not built yet — rebuild to detect matches across your existing photos.
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4 shrink-0" /> {pairCount} stored match pair{pairCount !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant={needsIndex ? "default" : "outline"}
          onClick={handleRebuildIndex}
          disabled={isRebuilding}
          data-testid="rebuild-near-dup-index-btn"
        >
          {isRebuilding ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CopyCheck className="h-4 w-4 mr-2" />}
          {isRebuilding ? "Rebuilding…" : "Rebuild index"}
        </Button>
      </div>

      {/* Controls: sensitivity + page size */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Sensitivity:</span>
          <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5" role="group" data-testid="near-dup-threshold">
            {THRESHOLD_OPTIONS.map((opt) => {
              const active = threshold === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => { setThreshold(opt.value); resetList(); }}
                  aria-pressed={active}
                  title={opt.hint}
                  data-testid={`near-dup-threshold-${opt.value}`}
                  className={cn(
                    "h-6 rounded-md px-2.5 text-xs font-medium transition-colors",
                    active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Show:</span>
          <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(parseInt(v, 10)); resetList(); }}>
            <SelectTrigger className="h-7 w-32 text-xs" data-testid="near-dup-page-size">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)}>{n} at a time</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {totalGroups !== null && (
          <span className="text-xs text-muted-foreground" data-testid="near-dup-total">
            {totalGroups} group{totalGroups !== 1 ? "s" : ""} at this sensitivity
          </span>
        )}
        {allGroups.length > 0 && (
          <Button size="sm" onClick={() => setCleanupOpen(true)} data-testid="interactive-cleanup-btn">
            <CopyCheck className="h-4 w-4 mr-1.5" /> Interactive cleanup
          </Button>
        )}
        {/* One-click cleanup of every group at the current sensitivity (#179). */}
        {extrasCount > 0 && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                disabled={isDeletingExtras}
                className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                data-testid="delete-all-matches-btn"
              >
                {isDeletingExtras ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Delete {extrasCount} match{extrasCount !== 1 ? "es" : ""} ≥ {minSimilarity}%
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Delete {extrasCount} duplicate{extrasCount !== 1 ? "s" : ""} at ≥ {minSimilarity}% similar?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  Across {extrasSummary!.groupCount} group{extrasSummary!.groupCount !== 1 ? "s" : ""} of photos
                  at least {minSimilarity}% similar, this keeps one copy of each — album covers are always kept —
                  and permanently deletes the {extrasCount} extra
                  {extrasCount !== 1 ? " copies" : " copy"} and their stored files. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleDeleteExtras}
                  className="bg-destructive hover:bg-destructive/90"
                  data-testid="confirm-delete-all-matches"
                >
                  Delete {extrasCount}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      <NearDuplicateCleanupModal
        open={cleanupOpen}
        onOpenChange={setCleanupOpen}
        groups={allGroups}
        onDeletePhoto={handleDelete}
        onIgnoreGroup={handleIgnoreGroup}
        isDeleting={isDeleting}
        isIgnoring={isIgnoring}
      />

      {/* Groups */}
      {initialLoading ? (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Scanning for near-duplicates…
        </div>
      ) : allGroups.length === 0 ? (
        <div className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" /> No near-duplicate photos found at this sensitivity
        </div>
      ) : (
        <div className="space-y-5 pb-20" data-testid="near-duplicate-groups">
          {allGroups.map((group) => (
            <div key={group.key} className="rounded-lg border border-border p-3 space-y-2" data-testid={`near-duplicate-group-${group.key}`}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground">
                  {group.photos.length} similar photo{group.photos.length !== 1 ? "s" : ""}
                </span>
                <span
                  className="text-[10px] text-muted-foreground"
                  title="Similarity from the perceptual hash: 64 bits total; the fewer that differ, the more alike (0 differing = visually identical)"
                >
                  {group.distance === 0
                    ? "visually identical"
                    : `≈${Math.round(((64 - group.distance) / 64) * 100)}% similar · ≤ ${group.distance} bits apart`}
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {group.photos.map((photo) => (
                  <DuplicatePhotoCard
                    key={photo.id}
                    photo={photo}
                    onDelete={handleDelete}
                    deleting={isDeleting}
                    selected={selected.has(photo.id)}
                    onToggleSelect={toggleSelected}
                  />
                ))}
              </div>
            </div>
          ))}

          {hasMore && (
            <div ref={sentinelRef} className="flex justify-center pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOffset(allGroups.length)}
                disabled={isFetching}
                data-testid="load-more-near-duplicates"
              >
                {isFetching ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                  </span>
                ) : (
                  `Load ${pageSize} more`
                )}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Selection bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5 shadow-lg" data-testid="near-dup-selection-bar">
          <span className="text-sm font-medium text-foreground">
            {selected.size} selected
          </span>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={isBulkDeleting}
                className="gap-1.5"
                data-testid="delete-selected-btn"
              >
                {isBulkDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Delete selected
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {selected.size} selected photo{selected.size !== 1 ? "s" : ""}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently deletes the selected photos and their stored files. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleDeleteSelected}
                  className="bg-destructive hover:bg-destructive/90"
                  data-testid="confirm-delete-selected"
                >
                  Delete {selected.size}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setSelected(new Set())}
            aria-label="Clear selection"
            data-testid="clear-selection-btn"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
    </AdminSectionShell>
  );
}
