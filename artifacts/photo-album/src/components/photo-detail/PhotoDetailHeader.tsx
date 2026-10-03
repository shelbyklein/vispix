import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ChevronLeft, ChevronRight, Loader2, Orbit, RotateCw } from "lucide-react";

/** Where the Previous/Next lookup stands (#210). */
export type PhotoNavState = "loading" | "ready" | "error" | "outside";

export function PhotoDetailHeader({
  albumId,
  albumTitle,
  prevPhotoId,
  nextPhotoId,
  navState,
  position,
  totalPhotos,
  onNavigate,
  onRetry,
  fallbackHref,
  back,
  exploreHref,
}: {
  albumId: number;
  albumTitle?: string | null;
  prevPhotoId: number | null;
  nextPhotoId: number | null;
  navState: PhotoNavState;
  position: number | null;
  totalPhotos: number;
  onNavigate: (id: number) => void;
  onRetry: () => void;
  /** The same photo without the browsing context (direct-link fallback). */
  fallbackHref: string | null;
  /** Opened from search results (#210): back to them instead of the album. */
  back?: { href: string; label: string } | null;
  /** The Photo Graph centred on this photo (#202). */
  exploreHref?: string;
}) {
  const fromSearch = !!back;
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        {back ? (
          <Button asChild variant="ghost" size="sm" className="gap-1.5" data-testid="back-to-search">
            <Link href={back.href}>
              <ArrowLeft className="h-4 w-4" />
              {back.label}
            </Link>
          </Button>
        ) : albumId ? (
          <Button asChild variant="ghost" size="sm" className="gap-1.5" data-testid="back-to-album">
            <Link href={`/albums/${albumId}`}>
              <ArrowLeft className="h-4 w-4" />
              {albumTitle ?? "Album"}
            </Link>
          </Button>
        ) : null}
        {exploreHref && (
          <Button asChild variant="outline" size="sm" className="gap-1.5" data-testid="explore-connections">
            <Link href={exploreHref}>
              <Orbit className="h-4 w-4" />
              Explore connections
            </Link>
          </Button>
        )}
      </div>
      {albumId && (
        <div className="flex items-center gap-1" data-testid="photo-nav">
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={prevPhotoId == null}
            onClick={() => prevPhotoId != null && onNavigate(prevPhotoId)}
            aria-label="Previous photo"
            data-testid="prev-photo-btn"
          >
            <ChevronLeft className="h-4 w-4" />
            Prev
          </Button>
          {navState === "loading" && (
            <span className="px-1 text-muted-foreground" data-testid="photo-position-loading" role="status" aria-label="Loading neighbouring photos">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            </span>
          )}
          {navState === "ready" && position != null && (
            <span className="text-xs text-muted-foreground px-1 tabular-nums" role="status" data-testid="photo-position">
              {position} / {totalPhotos}
            </span>
          )}
          {navState === "error" && (
            <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs" onClick={onRetry} data-testid="photo-nav-retry">
              <RotateCw className="h-3.5 w-3.5" />
              Couldn't load — retry
            </Button>
          )}
          {navState === "outside" && (
            <span className="text-xs text-muted-foreground px-1" role="status" data-testid="photo-nav-outside">
              {fromSearch ? "Not in these search results" : "Not in this album view"}
              {fallbackHref && (
                <>
                  {" · "}
                  <Link href={fallbackHref} className="underline hover:text-foreground">
                    browse whole album
                  </Link>
                </>
              )}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={nextPhotoId == null}
            onClick={() => nextPhotoId != null && onNavigate(nextPhotoId)}
            aria-label="Next photo"
            data-testid="next-photo-btn"
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
