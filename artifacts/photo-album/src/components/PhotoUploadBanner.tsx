import { Link } from "wouter";
import { CheckCircle2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { usePhotoUploadOptional } from "@/contexts/PhotoUploadContext";

// Persistent bottom banner for the simple "Upload Photos" dialog. Because the
// upload runs in PhotoUploadProvider (above the router), progress stays visible
// after the dialog closes or the user navigates to another page.
export function PhotoUploadBanner() {
  const ctx = usePhotoUploadOptional();
  if (!ctx || ctx.phase === "idle") return null;

  const { phase, albumId, albumTitle, total, completed, succeeded, failed, overallProgress, cancel, dismiss } = ctx;
  const albumHref = albumId != null ? `/albums/${albumId}` : "/albums";

  if (phase === "complete") {
    return (
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border shadow-lg" data-testid="photo-upload-banner">
        <div className="px-4 sm:px-6 lg:px-8 py-3 flex items-center gap-4">
          <CheckCircle2 className="h-4 w-4 text-success-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium text-foreground">Upload complete — </span>
            <span className="text-sm text-muted-foreground">
              {succeeded} photo{succeeded !== 1 ? "s" : ""} uploaded
              {failed > 0 && `, ${failed} failed`}
              {albumTitle && <> to <span className="text-foreground">{albumTitle}</span></>}
            </span>
          </div>
          <Link href={albumHref} className="text-xs text-primary font-medium whitespace-nowrap shrink-0 hover:text-primary/80">
            View album →
          </Link>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={dismiss} aria-label="Dismiss" data-testid="photo-upload-dismiss">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border shadow-lg" data-testid="photo-upload-banner">
      <div className="px-4 sm:px-6 lg:px-8 py-3 flex items-center gap-4">
        <Upload className="h-4 w-4 text-primary shrink-0 animate-bounce" />
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium text-foreground truncate">
              Uploading{albumTitle ? ` to ${albumTitle}` : ""}…
            </span>
            <span className="text-muted-foreground whitespace-nowrap shrink-0">{completed} / {total}</span>
          </div>
          <Progress value={overallProgress} className="h-1.5" />
        </div>
        <Link href={albumHref} className="text-xs text-primary font-medium whitespace-nowrap shrink-0 hover:text-primary/80">
          View album →
        </Link>
        <Button variant="outline" size="sm" className="h-7 shrink-0" onClick={cancel} data-testid="photo-upload-cancel">
          Stop
        </Button>
      </div>
    </div>
  );
}
