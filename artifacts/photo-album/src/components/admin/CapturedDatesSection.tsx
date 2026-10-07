import { useState } from "react";
import { useExifDateBackfillStatus, useBackfillExifDates } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { CalendarIcon, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type BackfillResult = {
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
};

export function CapturedDatesSection() {
  const { toast } = useToast();
  const [lastResult, setLastResult] = useState<BackfillResult | null>(null);
  const { data: statusData, isLoading: isStatusLoading } = useExifDateBackfillStatus();
  const { mutate: backfill, isPending } = useBackfillExifDates();

  function handleBackfill() {
    setLastResult(null);
    backfill(undefined, {
      onSuccess: (result) => {
        setLastResult(result);
        if (result.processed === 0) {
          toast({ title: "All photos already have capture dates" });
        } else if (result.failed === 0) {
          toast({ title: `Updated ${result.updated} photo${result.updated !== 1 ? "s" : ""} with capture dates` });
        } else {
          toast({
            title: "Capture date backfill completed with some errors",
            description: `${result.updated} updated, ${result.failed} failed`,
            variant: "destructive",
          });
        }
      },
      onError: () =>
        toast({ title: "Capture date backfill failed", variant: "destructive" }),
    });
  }

  const missingCount = statusData?.missingCount ?? null;

  return (
    <div
      className="rounded-xl border border-border bg-card overflow-hidden"
      data-testid="captured-dates-section"
    >
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <CalendarIcon className="h-4 w-4 text-muted-foreground" />
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-foreground">Capture Date Backfill</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Read EXIF metadata from existing photos to fill in missing capture dates.
          </p>
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        <p className="text-sm text-muted-foreground">
          Photos uploaded before EXIF extraction was added may be missing their capture date.
          This action reads each photo's embedded EXIF data and saves the date so date-based
          filters work correctly across your whole library.
        </p>

        <div className="text-sm" data-testid="exif-backfill-status">
          {isStatusLoading ? (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Checking…
            </span>
          ) : missingCount === 0 ? (
            <span className="flex items-center gap-1.5 text-success">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              All photos have capture dates (or no EXIF data)
            </span>
          ) : missingCount !== null ? (
            <span className="text-warning font-medium">
              {missingCount} photo{missingCount !== 1 ? "s" : ""} missing a capture date
            </span>
          ) : null}
        </div>

        {lastResult && (
          <div
            className="rounded-lg border border-border bg-background/50 px-4 py-3 text-sm space-y-1"
            data-testid="exif-backfill-result"
          >
            <div className="flex items-center gap-2 font-medium text-foreground">
              {lastResult.failed === 0 ? (
                <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
              ) : (
                <XCircle className="h-4 w-4 text-destructive shrink-0" />
              )}
              {lastResult.processed === 0
                ? "No photos needed capture dates"
                : `Processed ${lastResult.processed} photo${lastResult.processed !== 1 ? "s" : ""}`}
            </div>
            {lastResult.processed > 0 && (
              <div className="flex gap-4 text-xs text-muted-foreground pl-6">
                <span className="text-success">{lastResult.updated} updated</span>
                {lastResult.skipped > 0 && (
                  <span>{lastResult.skipped} skipped (no EXIF date)</span>
                )}
                {lastResult.failed > 0 && (
                  <span className="text-destructive">{lastResult.failed} failed</span>
                )}
              </div>
            )}
          </div>
        )}

        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleBackfill}
          disabled={isPending}
          data-testid="backfill-exif-dates-btn"
        >
          <CalendarIcon className="h-4 w-4 mr-2" />
          {isPending ? "Reading EXIF dates…" : "Fill in missing capture dates"}
        </Button>
      </div>
    </div>
  );
}
