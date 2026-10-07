import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  FolderOpen,
  ChevronDown,
  ChevronRight,
  Pause,
  Play,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from "lucide-react";
import type { QueueFile, ResolvedGroup } from "@/contexts/BulkUploadContext";

function humanSpeed(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

interface UploadingPhaseProps {
  queueFiles: QueueFile[];
  resolvedGroups: ResolvedGroup[];
  isPaused: boolean;
  speedBps: number;
  etaSeconds: number | null;
  totalFiles: number;
  completedFiles: number;
  overallProgress: number;
  expandedGroups: Set<string>;
  onTogglePause: () => void;
  onCancelGroup: (groupId: string) => void;
  onToggleGroupExpand: (groupId: string) => void;
}

export function UploadingPhase({
  queueFiles,
  resolvedGroups,
  isPaused,
  speedBps,
  etaSeconds,
  totalFiles,
  completedFiles,
  overallProgress,
  expandedGroups,
  onTogglePause,
  onCancelGroup,
  onToggleGroupExpand,
}: UploadingPhaseProps) {
  type GroupStatus = "queued" | "uploading" | "done" | "failed" | "cancelled";
  function getGroupStatus(groupId: string): GroupStatus {
    const files = queueFiles.filter((f) => f.groupId === groupId);
    if (files.length === 0) return "queued";
    if (files.every((f) => f.status === "pending" || f.status === "skipped")) return "queued";
    if (files.some((f) => f.status === "uploading")) return "uploading";
    const terminal = files.every((f) => ["done", "error", "skipped", "cancelled"].includes(f.status));
    if (terminal) {
      if (files.every((f) => f.status === "cancelled")) return "cancelled";
      if (files.some((f) => f.status === "error")) return "failed";
      return "done";
    }
    return "queued";
  }

  return (
    <AppLayout>
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-foreground">Uploading…</h1>
          <Button variant="outline" size="sm" onClick={onTogglePause} className="gap-2">
            {isPaused ? <><Play className="h-3.5 w-3.5" />Resume</> : <><Pause className="h-3.5 w-3.5" />Pause</>}
          </Button>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {completedFiles} / {totalFiles} files
              {speedBps > 0 && <span className="ml-2">{humanSpeed(speedBps)}</span>}
            </span>
            {etaSeconds !== null && (
              <span>~{etaSeconds < 60 ? `${etaSeconds}s` : `${Math.floor(etaSeconds / 60)}m ${etaSeconds % 60}s`} remaining</span>
            )}
          </div>
          <Progress value={overallProgress} className="h-2" />
        </div>

        <div className="space-y-3">
          {resolvedGroups.map((group) => {
            const groupFiles = queueFiles.filter((f) => f.groupId === group.id);
            const groupDone = groupFiles.filter((f) => f.status === "done").length;
            const groupFailed = groupFiles.filter((f) => f.status === "error").length;
            const groupTotal = groupFiles.filter((f) => f.status !== "skipped").length;
            const status = getGroupStatus(group.id);
            const isExpanded = expandedGroups.has(group.id);
            const folderIds = [...new Set(groupFiles.map((f) => f.folderId))];

            return (
              <div key={group.id} className="rounded-lg border border-border bg-card overflow-hidden">
                <div className="px-4 py-3 flex items-center gap-3">
                  <button onClick={() => onToggleGroupExpand(group.id)} className="text-muted-foreground hover:text-foreground transition-colors">
                    {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{group.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {status === "queued" && "Queued"}
                      {status === "uploading" && `Uploading ${groupDone + 1} / ${groupTotal}`}
                      {status === "done" && `${groupDone} uploaded${groupFailed > 0 ? `, ${groupFailed} failed` : ""}`}
                      {status === "failed" && `${groupDone} done, ${groupFailed} failed`}
                      {status === "cancelled" && "Cancelled"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {(status === "queued" || status === "uploading") && (
                      <button onClick={() => onCancelGroup(group.id)} className="text-xs text-muted-foreground hover:text-destructive transition-colors" title="Cancel upload">
                        <X className="h-4 w-4" />
                      </button>
                    )}
                    {status === "uploading" && <Loader2 className="h-4 w-4 text-primary animate-spin" />}
                    {status === "done" && <CheckCircle2 className="h-4 w-4 text-success" />}
                    {status === "failed" && <AlertCircle className="h-4 w-4 text-warning" />}
                    {status === "cancelled" && <X className="h-4 w-4 text-muted-foreground" />}
                  </div>
                </div>

                {isExpanded && folderIds.length > 0 && (
                  <div className="border-t border-border divide-y divide-border">
                    {folderIds.map((folderId) => {
                      const folderFiles = groupFiles.filter((f) => f.folderId === folderId);
                      const folderName = folderFiles[0]?.folderName ?? folderId;
                      const folderDone = folderFiles.filter((f) => f.status === "done").length;
                      const folderFailed = folderFiles.filter((f) => f.status === "error").length;
                      const folderTotal = folderFiles.filter((f) => f.status !== "skipped").length;
                      const folderUploading = folderFiles.filter((f) => f.status === "uploading").length;

                      return (
                        <div key={folderId} className="px-8 py-2.5 flex items-center gap-3">
                          <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-foreground truncate">{folderName}</p>
                            <p className="text-xs text-muted-foreground">
                              {folderUploading > 0 ? `Uploading ${folderDone + 1} / ${folderTotal}` : `${folderDone} / ${folderTotal}`}
                              {folderFailed > 0 && ` · ${folderFailed} failed`}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </AppLayout>
  );
}
