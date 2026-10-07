import { useState } from "react";
import { Link } from "wouter";
import {
  useGetDuplicatesSummary,
  getGetDuplicatesSummaryQueryKey,
  getListDuplicatePhotoGroupsQueryKey,
  useDeleteDuplicateExtras,
  useContentHashBackfillStatus,
  useBackfillContentHashes,
  getGetRecentPhotosQueryKey,
  getGetTopRatedPhotosQueryKey,
} from "@workspace/api-client-react";
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
import { Copy, CheckCircle2, Loader2, Trash2, ArrowRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type BackfillResult = {
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
};

// Summary-only card: counts + hash backfill + "delete all extras". The
// per-group review UI lives on the /admin/duplicates page (which embeds this
// card with showManageLink=false) — this section never fetches the
// (potentially hundreds of) groups themselves.
export function DuplicatesSection({ showManageLink = true }: { showManageLink?: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [lastBackfill, setLastBackfill] = useState<BackfillResult | null>(null);

  const { data: statusData, isLoading: isStatusLoading } = useContentHashBackfillStatus();
  const { mutate: backfill, isPending: isBackfilling } = useBackfillContentHashes();
  const { data: summary, isLoading: isSummaryLoading } = useGetDuplicatesSummary();
  const { mutate: deleteExtras, isPending: isDeletingExtras } = useDeleteDuplicateExtras();

  const missingCount = statusData?.missingCount ?? null;
  const groupCount = summary?.groupCount ?? 0;
  const extraCount = summary?.extraCount ?? 0;

  function refresh() {
    qc.invalidateQueries({ queryKey: getGetDuplicatesSummaryQueryKey() });
    qc.invalidateQueries({ queryKey: getListDuplicatePhotoGroupsQueryKey().slice(0, 1) });
    qc.invalidateQueries({ queryKey: ["admin", "photos", "content-hash-backfill-status"] });
    qc.invalidateQueries({ queryKey: getGetRecentPhotosQueryKey() });
    qc.invalidateQueries({ queryKey: getGetTopRatedPhotosQueryKey() });
  }

  function handleDeleteExtras() {
    deleteExtras(undefined, {
      onSuccess: (result) => {
        toast({ title: `Deleted ${result.deleted} duplicate${result.deleted !== 1 ? "s" : ""}` });
        refresh();
      },
      onError: () => toast({ title: "Bulk delete failed", variant: "destructive" }),
    });
  }

  function handleBackfill() {
    setLastBackfill(null);
    backfill(undefined, {
      onSuccess: (result) => {
        setLastBackfill(result);
        if (result.processed === 0) {
          toast({ title: "All photos already have a content hash" });
        } else if (result.failed === 0) {
          toast({ title: `Hashed ${result.updated} photo${result.updated !== 1 ? "s" : ""}` });
        } else {
          toast({
            title: "Content hashing completed with some errors",
            description: `${result.updated} hashed, ${result.failed} failed`,
            variant: "destructive",
          });
        }
        refresh();
      },
      onError: () => toast({ title: "Content hashing failed", variant: "destructive" }),
    });
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden" data-testid="duplicates-section">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <Copy className="h-4 w-4 text-muted-foreground" />
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-foreground">Duplicate Photos</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Find byte-identical duplicate photos. Review groups on the duplicates page, or delete all extras at once.
          </p>
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Content-hash backfill: hashes must exist before duplicates can be detected. */}
        <div className="rounded-lg border border-border bg-background/40 px-4 py-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            Duplicate detection compares each photo's content hash. Photos uploaded before hashing was added need
            their hash computed once.
          </p>
          <div className="text-sm" data-testid="content-hash-status">
            {isStatusLoading ? (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…
              </span>
            ) : missingCount === 0 ? (
              <span className="flex items-center gap-1.5 text-success">
                <CheckCircle2 className="h-4 w-4 shrink-0" /> All photos are hashed
              </span>
            ) : missingCount !== null ? (
              <span className="text-warning font-medium">
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
            data-testid="backfill-content-hashes-btn"
          >
            <Copy className="h-4 w-4 mr-2" />
            {isBackfilling ? "Computing hashes…" : "Compute missing hashes"}
          </Button>
        </div>

        {/* Summary + actions — no group cards here. */}
        {isSummaryLoading ? (
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Scanning for duplicates…
          </div>
        ) : groupCount === 0 ? (
          <div className="flex items-center gap-1.5 text-sm text-success">
            <CheckCircle2 className="h-4 w-4 shrink-0" /> No duplicate photos found
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 flex-wrap" data-testid="duplicates-summary">
            <p className="text-sm text-foreground">
              <span className="font-semibold">{groupCount}</span> duplicate group{groupCount !== 1 ? "s" : ""} ·{" "}
              <span className="font-semibold">{extraCount}</span> deletable extra{extraCount !== 1 ? "s" : ""}
            </p>
            <div className="flex items-center gap-2">
              {showManageLink && (
                <Link href="/admin/duplicates">
                  <Button type="button" size="sm" variant="outline" className="gap-1.5" data-testid="manage-duplicates-link">
                    Manage duplicates
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                </Link>
              )}
              {extraCount > 0 && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={isDeletingExtras}
                      className="shrink-0 gap-1.5"
                      data-testid="delete-all-duplicates-btn"
                    >
                      {isDeletingExtras ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      Delete {extraCount} extra{extraCount !== 1 ? "s" : ""}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete {extraCount} duplicate photo{extraCount !== 1 ? "s" : ""}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This keeps one photo from each identical group (album covers when there are any) and
                        permanently deletes the rest, including their stored files. This cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleDeleteExtras}
                        className="bg-destructive hover:bg-destructive/90"
                        data-testid="confirm-delete-all-duplicates"
                      >
                        Delete {extraCount} photo{extraCount !== 1 ? "s" : ""}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
