import { useState } from "react";
import {
  useEmbeddingStatus,
  useUpdateEmbeddingSettings,
  useBackfillEmbeddings,
  useStopEmbeddingBackfill,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Boxes, CheckCircle2, XCircle, Loader2, AlertTriangle, Square } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export function EmbeddingsSection() {
  const { toast } = useToast();
  // pollWhileRunning: the status query auto-refetches every 1.5s while a
  // backfill job is running, so the progress count updates live (#31).
  const { data: status, isLoading } = useEmbeddingStatus({ pollWhileRunning: true });
  const { mutate: updateSettings, isPending: updating } = useUpdateEmbeddingSettings();
  const { mutate: backfill, isPending: starting } = useBackfillEmbeddings();
  const { mutate: stopBackfill, isPending: stopping } = useStopEmbeddingBackfill();
  const [limitInput, setLimitInput] = useState("");

  const configured = Boolean(status?.projectConfigured && status?.credentialsConfigured);
  const job = status?.job ?? null;
  const running = job?.running ?? false;

  function handleToggle(enabled: boolean) {
    updateSettings(
      { enabled },
      {
        onSuccess: () =>
          toast({ title: enabled ? "Image embeddings enabled" : "Image embeddings disabled" }),
        onError: () => toast({ title: "Failed to update setting", variant: "destructive" }),
      },
    );
  }

  function handleBackfill() {
    const trimmed = limitInput.trim();
    const limit = trimmed ? parseInt(trimmed, 10) : undefined;
    if (trimmed && (!Number.isInteger(limit) || (limit as number) <= 0)) {
      toast({ title: "Batch size must be a positive whole number", variant: "destructive" });
      return;
    }
    backfill(limit != null ? { limit } : undefined, {
      onError: () => toast({ title: "Couldn't start embedding backfill", variant: "destructive" }),
    });
  }

  function handleStop() {
    stopBackfill(undefined, {
      onSuccess: () => toast({ title: "Stopping — finishing the current photo" }),
      onError: () => toast({ title: "Couldn't stop the backfill", variant: "destructive" }),
    });
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden" data-testid="embeddings-section">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <Boxes className="h-4 w-4 text-muted-foreground" />
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-foreground">Image Embeddings</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Google Vertex AI multimodal embeddings power semantic search and “similar photos”.
          </p>
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        {!isLoading && !configured && (
          <div
            className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning-foreground"
            data-testid="embeddings-not-configured"
          >
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Vertex AI isn’t fully configured.</p>
              <p className="text-xs mt-0.5">
                Set <code>GOOGLE_APPLICATION_CREDENTIALS</code>
                {status && !status.projectConfigured && (
                  <>, <code>VERTEX_PROJECT</code></>
                )}{" "}
                and <code>VERTEX_LOCATION</code> in <code>.env</code>, then restart the API server.
              </p>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-background/50 px-4 py-3">
          <div>
            <p className="text-sm font-medium text-foreground">Generate embeddings on upload</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {status ? `${status.model} · ${status.location}` : "…"}
            </p>
          </div>
          <Switch
            checked={status?.enabled ?? false}
            onCheckedChange={handleToggle}
            disabled={isLoading || updating || !configured}
            data-testid="embeddings-enabled-switch"
          />
        </div>

        <div className="text-sm" data-testid="embeddings-status">
          {isLoading ? (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Checking…
            </span>
          ) : status ? (
            <span className="text-muted-foreground">
              <span className="text-success-foreground font-medium">
                {status.embeddedCount}
              </span>{" "}
              embedded
              {status.missingCount > 0 && (
                <>
                  {" · "}
                  <span className="text-warning-foreground font-medium">
                    {status.missingCount}
                  </span>{" "}
                  missing
                </>
              )}
            </span>
          ) : null}
        </div>

        {/* Live job progress (#31) — shown while running, and as a summary once
            a batch finishes (or is stopped) until the next one starts. */}
        {job && (
          <div
            className="rounded-lg border border-border bg-background/50 px-4 py-3 text-sm space-y-2"
            data-testid="embeddings-job"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-medium text-foreground">
                {running ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                    Embedding photos… {job.processed} / {job.total || "…"}
                  </>
                ) : job.stopped ? (
                  <>
                    <XCircle className="h-4 w-4 text-warning-foreground shrink-0" />
                    Stopped — {job.processed} of {job.total} processed
                  </>
                ) : job.total === 0 ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-success-foreground shrink-0" />
                    No photos needed embedding
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-success-foreground shrink-0" />
                    Done — {job.processed} of {job.total} processed
                  </>
                )}
              </div>
              {running && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleStop}
                  disabled={stopping}
                  data-testid="stop-embeddings-btn"
                >
                  <Square className="h-3.5 w-3.5 mr-1.5 fill-current" />
                  {stopping ? "Stopping…" : "Stop"}
                </Button>
              )}
            </div>
            {job.total > 0 && (
              <Progress value={(job.processed / job.total) * 100} className="h-1.5" />
            )}
            {job.processed > 0 && (
              <div className="flex gap-4 text-xs text-muted-foreground">
                <span className="text-success-foreground">{job.succeeded} succeeded</span>
                {job.failed > 0 && <span className="text-destructive">{job.failed} failed</span>}
              </div>
            )}
          </div>
        )}

        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="embeddings-batch-size" className="text-xs text-muted-foreground">
              Batch size (blank = all)
            </Label>
            <Input
              id="embeddings-batch-size"
              type="number"
              min={1}
              placeholder="All"
              className="w-28 h-9"
              value={limitInput}
              onChange={(e) => setLimitInput(e.target.value)}
              disabled={running}
              data-testid="embeddings-batch-size-input"
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleBackfill}
            disabled={starting || running || !status?.enabled}
            data-testid="backfill-embeddings-btn"
            title={!status?.enabled ? "Enable embeddings first" : undefined}
          >
            <Boxes className="h-4 w-4 mr-2" />
            {running ? "Embedding photos…" : starting ? "Starting…" : "Embed photos missing vectors"}
          </Button>
        </div>
      </div>
    </div>
  );
}
