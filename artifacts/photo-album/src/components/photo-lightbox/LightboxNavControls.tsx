import { X, Loader2, ChevronLeft, ChevronRight } from "lucide-react";

export function LightboxNavControls({
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  isLoadingNext,
}: {
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  isLoadingNext?: boolean;
}) {
  // Below `lg` the arrows share a top row with Close (prev left, next beside
  // Close); from `lg` they sit in side gutters the stage reserves. Either way
  // they never overlap the photo's action row (#219).
  return (
    <>
      <button
        onClick={onClose}
        className="fixed top-3 right-3 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors focus:outline-none focus:ring-2 focus:ring-white z-10"
        aria-label="Close preview"
        data-testid="lightbox-close"
      >
        <X className="h-5 w-5" />
      </button>

      {onPrev && (
        <button
          onClick={(e) => { e.stopPropagation(); onPrev(); }}
          disabled={!hasPrev}
          className="fixed top-3 left-3 lg:top-1/2 lg:-translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors focus:outline-none focus:ring-2 focus:ring-white z-10 disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Previous photo"
          data-testid="lightbox-prev"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
      )}

      {onNext && (
        <button
          onClick={(e) => { e.stopPropagation(); if (!isLoadingNext) onNext(); }}
          disabled={!hasNext || isLoadingNext}
          className="fixed top-3 right-16 lg:right-3 lg:top-1/2 lg:-translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors focus:outline-none focus:ring-2 focus:ring-white z-10 disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Next photo"
          data-testid="lightbox-next"
        >
          {isLoadingNext ? (
            <Loader2 className="h-6 w-6 animate-spin" />
          ) : (
            <ChevronRight className="h-6 w-6" />
          )}
        </button>
      )}
    </>
  );
}
