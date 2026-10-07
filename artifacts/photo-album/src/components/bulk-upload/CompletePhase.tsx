import { useRef } from "react";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  CheckCircle2,
  ArrowLeft,
  Link as LinkIcon,
  RefreshCw,
} from "lucide-react";
import type { QueueFile, ResolvedGroup } from "@/contexts/BulkUploadContext";

interface CompletePhaseProps {
  queueFiles: QueueFile[];
  resolvedGroups: ResolvedGroup[];
  canRetry: boolean;
  orphanedCount: number;
  onRetryFailed: (groupId?: string) => void;
  onReattachAndRetry: (files: File[]) => number;
  onNavigate: (path: string) => void;
  onStartNewBatch: () => void;
}

export function CompletePhase({
  queueFiles,
  resolvedGroups,
  canRetry,
  orphanedCount,
  onRetryFailed,
  onReattachAndRetry,
  onNavigate,
  onStartNewBatch,
}: CompletePhaseProps) {
  const { toast } = useToast();
  const reattachInputRef = useRef<HTMLInputElement>(null);

  const totalDone = queueFiles.filter((f) => f.status === "done").length;
  const totalFailed = queueFiles.filter((f) => f.status === "error").length;
  const totalSkipped = queueFiles.filter((f) => f.status === "skipped").length;
  const totalCancelled = queueFiles.filter((f) => f.status === "cancelled").length;

  function handleReattachInput(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    const matched = onReattachAndRetry(files);
    if (matched === 0) {
      toast({
        title: "No matching files found",
        description: "Select the same files from the interrupted upload.",
        variant: "destructive",
      });
    } else {
      toast({ title: `Retrying ${matched} file${matched !== 1 ? "s" : ""}…` });
    }
    if (reattachInputRef.current) reattachInputRef.current.value = "";
  }

  return (
    <AppLayout>
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => onNavigate("/albums")} className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back to Albums
          </Button>
        </div>

        <div className="text-center py-8 space-y-3">
          <div className="h-14 w-14 rounded-full bg-success/15 flex items-center justify-center mx-auto">
            <CheckCircle2 className="h-7 w-7 text-success-foreground" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">Upload Complete</h1>
          <p className="text-muted-foreground text-sm">
            {totalDone} photo{totalDone !== 1 ? "s" : ""} uploaded
            {totalSkipped > 0 && `, ${totalSkipped} skipped`}
            {totalFailed > 0 && `, ${totalFailed} failed`}
            {totalCancelled > 0 && `, ${totalCancelled} cancelled`}
          </p>
          {canRetry && (
            <Button variant="outline" size="sm" className="gap-2" onClick={() => onRetryFailed()}>
              <RefreshCw className="h-3.5 w-3.5" />
              Retry {totalFailed} failed
            </Button>
          )}
          {orphanedCount > 0 && (
            <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-left space-y-2 max-w-sm mx-auto">
              <p className="text-sm font-medium text-warning-foreground">
                {orphanedCount} file{orphanedCount !== 1 ? "s" : ""} interrupted
              </p>
              <p className="text-xs text-warning-foreground">
                These files were uploading when the tab was closed. Re-select them to retry.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="gap-2 border-warning/40 text-warning-foreground hover:bg-warning/15"
                onClick={() => reattachInputRef.current?.click()}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Re-select files to retry
              </Button>
              <input
                ref={reattachInputRef}
                type="file"
                multiple
                accept="image/*"
                className="hidden"
                onChange={handleReattachInput}
              />
            </div>
          )}
        </div>

        <div className="space-y-3">
          {resolvedGroups.map((group) => {
            const groupFiles = queueFiles.filter((f) => f.groupId === group.id);
            const done = groupFiles.filter((f) => f.status === "done").length;
            const failed = groupFiles.filter((f) => f.status === "error").length;
            const cancelled = groupFiles.filter((f) => f.status === "cancelled").length;
            const hasGroupErrors = failed > 0 && canRetry;

            return (
              <div key={group.id} className="rounded-lg border border-border bg-card p-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium text-foreground text-sm truncate">{group.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {done} uploaded
                    {failed > 0 && `, ${failed} failed`}
                    {cancelled > 0 && `, ${cancelled} cancelled`}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {hasGroupErrors && (
                    <Button variant="ghost" size="sm" className="gap-1.5 text-xs h-7" onClick={() => onRetryFailed(group.id)}>
                      <RefreshCw className="h-3 w-3" />
                      Retry {failed}
                    </Button>
                  )}
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/albums/${group.albumId}`}>
                      <LinkIcon className="h-3.5 w-3.5 mr-1.5" />
                      View Album
                    </Link>
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex gap-3 justify-center pt-2">
          <Button variant="outline" onClick={() => onNavigate("/albums")}>Back to Albums</Button>
          <Button onClick={onStartNewBatch}>Start New Batch</Button>
        </div>
      </div>
    </AppLayout>
  );
}
