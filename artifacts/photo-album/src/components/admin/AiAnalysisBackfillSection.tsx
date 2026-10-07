import { useState } from "react";
import {
  useAiAnalysisBackfillStatus,
  useBackfillAiAnalysis,
  useAiAnalysisBackfillRuns,
  useAiAutoBackfillSettings,
  useUpdateAiAutoBackfillSettings,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Bot, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatDateTime } from "@/lib/format-date";

type BackfillResult = {
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
};

export function AiAnalysisBackfillSection() {
  const { toast } = useToast();
  const [lastResult, setLastResult] = useState<BackfillResult | null>(null);
  const [batchSizeInput, setBatchSizeInput] = useState("");

  const { data: statusData, isLoading: isStatusLoading } = useAiAnalysisBackfillStatus();
  const { mutate: backfill, isPending } = useBackfillAiAnalysis();
  const { data: runs, isLoading: isRunsLoading } = useAiAnalysisBackfillRuns();
  const { data: autoSettings, isLoading: isAutoSettingsLoading } = useAiAutoBackfillSettings();
  const { mutate: updateAutoSettings, isPending: isUpdatingAutoSettings } =
    useUpdateAiAutoBackfillSettings();

  function handleBackfill() {
    const trimmed = batchSizeInput.trim();
    const limit = trimmed ? parseInt(trimmed, 10) : undefined;
    if (trimmed && (!Number.isInteger(limit) || (limit as number) <= 0)) {
      toast({ title: "Batch size must be a positive whole number", variant: "destructive" });
      return;
    }

    setLastResult(null);
    backfill(limit != null ? { limit } : undefined, {
      onSuccess: (result) => {
        setLastResult(result);
        if (result.processed === 0) {
          toast({ title: "All photos already have AI descriptions" });
        } else if (result.failed === 0) {
          toast({ title: `Analyzed ${result.succeeded} photo${result.succeeded !== 1 ? "s" : ""}` });
        } else {
          toast({
            title: "AI analysis backfill completed with some errors",
            description: `${result.succeeded} succeeded, ${result.failed} failed`,
            variant: "destructive",
          });
        }
      },
      onError: () =>
        toast({ title: "AI analysis backfill failed", variant: "destructive" }),
    });
  }

  function handleToggleAuto(enabled: boolean) {
    updateAutoSettings(
      { enabled },
      {
        onSuccess: () =>
          toast({ title: enabled ? "Automatic backfill enabled" : "Automatic backfill disabled" }),
        onError: () => toast({ title: "Failed to update setting", variant: "destructive" }),
      },
    );
  }

  function handleAutoBatchSizeBlur(value: string) {
    const parsed = parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed === autoSettings?.batchSize) return;
    updateAutoSettings(
      { batchSize: parsed },
      {
        onError: () => toast({ title: "Failed to update batch size", variant: "destructive" }),
      },
    );
  }

  const missingCount = statusData?.missingCount ?? null;

  return (
    <div
      className="rounded-xl border border-border bg-card overflow-hidden"
      data-testid="ai-analysis-backfill-section"
    >
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <Bot className="h-4 w-4 text-muted-foreground" />
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-foreground">AI Analysis Backfill</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Generate AI descriptions for photos that were never analyzed — e.g. uploaded before
            AI was enabled or configured.
          </p>
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        <p className="text-sm text-muted-foreground">
          Finds every photo without an AI description — regardless of whether analysis was never
          attempted, was skipped, or previously failed — and runs analysis against the currently
          configured AI provider.
        </p>

        <div className="text-sm" data-testid="ai-backfill-status">
          {isStatusLoading ? (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Checking…
            </span>
          ) : missingCount === 0 ? (
            <span className="flex items-center gap-1.5 text-success-foreground">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              All photos have AI descriptions
            </span>
          ) : missingCount !== null ? (
            <span className="text-warning-foreground font-medium">
              {missingCount} photo{missingCount !== 1 ? "s" : ""} missing an AI description
            </span>
          ) : null}
        </div>

        {lastResult && (
          <div
            className="rounded-lg border border-border bg-background/50 px-4 py-3 text-sm space-y-1"
            data-testid="ai-backfill-result"
          >
            <div className="flex items-center gap-2 font-medium text-foreground">
              {lastResult.failed === 0 ? (
                <CheckCircle2 className="h-4 w-4 text-success-foreground shrink-0" />
              ) : (
                <XCircle className="h-4 w-4 text-destructive shrink-0" />
              )}
              {lastResult.processed === 0
                ? "No photos needed AI analysis"
                : `Processed ${lastResult.processed} photo${lastResult.processed !== 1 ? "s" : ""}`}
            </div>
            {lastResult.processed > 0 && (
              <div className="flex gap-4 text-xs text-muted-foreground pl-6">
                <span className="text-success-foreground">{lastResult.succeeded} succeeded</span>
                {lastResult.skipped > 0 && <span>{lastResult.skipped} skipped</span>}
                {lastResult.failed > 0 && (
                  <span className="text-destructive">{lastResult.failed} failed</span>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="ai-backfill-batch-size" className="text-xs text-muted-foreground">
              Batch size (blank = all)
            </Label>
            <Input
              id="ai-backfill-batch-size"
              type="number"
              min={1}
              placeholder="All"
              className="w-28 h-9"
              value={batchSizeInput}
              onChange={(e) => setBatchSizeInput(e.target.value)}
              data-testid="ai-backfill-batch-size-input"
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleBackfill}
            disabled={isPending}
            data-testid="backfill-ai-analysis-btn"
          >
            <Bot className="h-4 w-4 mr-2" />
            {isPending ? "Analyzing photos…" : "Analyze photos missing descriptions"}
          </Button>
        </div>

        <div className="rounded-lg border border-border bg-background/50 px-4 py-3 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-foreground">Run automatically in the background</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Every 5 minutes, process one batch of unanalyzed photos while enabled.
              </p>
            </div>
            <Switch
              checked={autoSettings?.enabled ?? false}
              onCheckedChange={handleToggleAuto}
              disabled={isAutoSettingsLoading || isUpdatingAutoSettings}
              data-testid="ai-auto-backfill-switch"
            />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="ai-auto-backfill-batch-size" className="text-xs text-muted-foreground">
              Batch size per run
            </Label>
            <Input
              id="ai-auto-backfill-batch-size"
              type="number"
              min={1}
              className="w-24 h-8"
              defaultValue={autoSettings?.batchSize}
              key={autoSettings?.batchSize}
              onBlur={(e) => handleAutoBatchSizeBlur(e.target.value)}
              disabled={isAutoSettingsLoading}
              data-testid="ai-auto-backfill-batch-size-input"
            />
          </div>
        </div>

        {runs && runs.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Recent runs
            </p>
            <div className="rounded-lg border border-border overflow-hidden" data-testid="ai-backfill-runs-log">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">When</TableHead>
                    <TableHead className="text-xs">Trigger</TableHead>
                    <TableHead className="text-xs text-right">Processed</TableHead>
                    <TableHead className="text-xs text-right">Succeeded</TableHead>
                    <TableHead className="text-xs text-right">Skipped</TableHead>
                    <TableHead className="text-xs text-right">Failed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((run) => (
                    <TableRow key={run.id} data-testid={`ai-backfill-run-${run.id}`}>
                      <TableCell className="text-xs">
                        {formatDateTime(run.createdAt)}
                      </TableCell>
                      <TableCell className="text-xs capitalize">{run.trigger}</TableCell>
                      <TableCell className="text-xs text-right">{run.processed}</TableCell>
                      <TableCell className="text-xs text-right text-success-foreground">
                        {run.succeeded}
                      </TableCell>
                      <TableCell className="text-xs text-right">{run.skipped}</TableCell>
                      <TableCell className="text-xs text-right text-destructive">{run.failed}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
        {isRunsLoading && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading run history…
          </span>
        )}
      </div>
    </div>
  );
}
