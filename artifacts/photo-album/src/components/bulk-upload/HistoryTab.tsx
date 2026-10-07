import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { formatDate, formatDateTime } from "@/lib/format-date";
import { Loader2, Link as LinkIcon, Clock } from "lucide-react";

function formatRelativeTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  if (diffSecs < 60) return "just now";
  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(d);
}

function formatAbsoluteDate(date: Date | string): string {
  return formatDateTime(date);
}

interface Album {
  id: number;
  title: string;
}

interface BatchRecord {
  id: number;
  groupNames: string[];
  albumIds: number[];
  totalUploaded: number;
  failedCount: number;
  createdAt: Date | string;
}

export function HistoryTab({ batches, isLoading, albums }: { batches: BatchRecord[]; isLoading: boolean; albums: Album[] }) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading history…</span>
      </div>
    );
  }

  if (batches.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
        <Clock className="h-10 w-10 opacity-30" />
        <div className="text-center">
          <p className="text-sm font-medium">No upload history yet</p>
          <p className="text-xs mt-1 opacity-70">Completed batches will appear here</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {batches.map((batch) => {
        const albumMap = new Map(albums.map((a) => [a.id, a.title]));
        const hasFailures = batch.failedCount > 0;

        return (
          <div key={batch.id} className="rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  {batch.groupNames.map((name, i) => (
                    <span key={i} className="text-sm font-medium text-foreground bg-muted/60 px-2 py-0.5 rounded">
                      {name}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-1.5">
                  {batch.totalUploaded} photo{batch.totalUploaded !== 1 ? "s" : ""} uploaded
                  {hasFailures && <span className="text-warning ml-1">· {batch.failedCount} failed</span>}
                </p>
              </div>
              <time
                className="text-xs text-muted-foreground shrink-0 mt-0.5"
                title={formatAbsoluteDate(batch.createdAt)}
              >
                {formatRelativeTime(batch.createdAt)}
              </time>
            </div>

            {batch.albumIds.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {batch.albumIds.map((albumId) => (
                  <Button key={albumId} variant="outline" size="sm" asChild className="h-7 text-xs">
                    <Link href={`/albums/${albumId}`}>
                      <LinkIcon className="h-3 w-3 mr-1.5" />
                      {albumMap.get(albumId) ?? `Album ${albumId}`}
                    </Link>
                  </Button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
