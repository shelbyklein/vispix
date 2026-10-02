import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ExternalLink, Download, Ban } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { Link } from "wouter";
import {
  useGetPhoto,
  useUpdatePhoto,
  useRatePhoto,
  useGetMe,
  getGetPhotoQueryKey,
  getGetTopRatedPhotosQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { PhotoSidebarContent } from "@/components/photo-lightbox/PhotoSidebarContent";
import { LightboxImageArea } from "@/components/photo-lightbox/LightboxImageArea";
import { LightboxNavControls } from "@/components/photo-lightbox/LightboxNavControls";
import type { LightboxPhoto } from "@/components/photo-lightbox/types";
import { useCapabilities } from "@/hooks/useCapabilities";

export type { LightboxPhoto };

interface PhotoLightboxProps {
  photo: LightboxPhoto | null;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  isLoadingNext?: boolean;
  albumId?: number | null;
  coverPhotoId?: number | null;
  onDeleted?: (photoId: number) => void;
  // When set (smart-collection context), a "Not applicable" action appears that
  // marks the photo as a negative example for that collection.
  onMarkNotApplicable?: (photoId: number) => void;
  // Whether submitting a rating moves to the next photo (keyboard digits and
  // star clicks). Album review flows want this; search/smart-collection don't.
  advanceOnRate?: boolean;
  /** Query string for the "view details" link, describing the view the photo
   * was opened from (e.g. the album and its filters, #210), so the details
   * page's Previous/Next follow the same sequence. */
  detailsQuery?: string;
}

const SWIPE_THRESHOLD = 50;

export function PhotoLightbox({ photo, onClose, onPrev, onNext, hasPrev, hasNext, isLoadingNext, albumId, coverPhotoId, onDeleted, onMarkNotApplicable, advanceOnRate = true, detailsQuery }: PhotoLightboxProps) {
  const imgSrc = photo?.url ?? undefined;
  const touchStartX = useRef<number | null>(null);
  const qc = useQueryClient();
  const { mutate: ratePhotoKb } = useRatePhoto();

  const [localCoverPhotoId, setLocalCoverPhotoId] = useState<number | null | undefined>(coverPhotoId);
  useEffect(() => {
    setLocalCoverPhotoId(coverPhotoId);
  }, [coverPhotoId]);

  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState(false);
  useLayoutEffect(() => {
    if (photo?.id != null) {
      setImageLoading(true);
      setImageError(false);
    }
  }, [photo?.id]);

  const handleAdvance = useCallback(() => {
    if (hasNext && onNext) onNext();
  }, [hasNext, onNext]);

  const handleMarkNotApplicable = useCallback(() => {
    if (!photo || !onMarkNotApplicable) return;
    onMarkNotApplicable(photo.id);
    // The photo drops from the collection's results — move on or close.
    if (hasNext && onNext) onNext();
    else onClose();
  }, [photo, onMarkNotApplicable, hasNext, onNext, onClose]);

  const { mutate: updatePhotoKb } = useUpdatePhoto();
  const { data: me } = useGetMe();
  const caps = useCapabilities();
  const { toast: toastKb } = useToast();
  // Shares the cache with the sidebar's useGetPhoto (same query key) — no extra
  // request. Used to show the AI description directly under the photo.
  const { data: fullPhoto } = useGetPhoto(photo?.id ?? 0, {
    query: { enabled: !!photo?.id, queryKey: getGetPhotoQueryKey(photo?.id ?? 0) },
  });

  // Stable refs so keydown listeners always call the latest version
  const hideAndAdvanceRef = useRef<() => void>(() => {});
  hideAndAdvanceRef.current = useCallback(() => {
    if (!photo || !caps.isOrgManager) return;
    updatePhotoKb(
      { id: photo.id, data: { isHidden: true } },
      {
        onSuccess: () => {
          toastKb({ title: "Photo hidden" });
          handleAdvance();
        },
      },
    );
  }, [photo, me, updatePhotoKb, toastKb, handleAdvance]);

  const rateAndAdvanceRef = useRef<(score: number) => void>(() => {});
  rateAndAdvanceRef.current = useCallback((score: number) => {
    if (!photo) return;
    ratePhotoKb(
      { id: photo.id, data: { score } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetPhotoQueryKey(photo.id) });
          qc.invalidateQueries({ queryKey: getGetTopRatedPhotosQueryKey() });
          if (advanceOnRate) handleAdvance();
        },
      }
    );
  }, [photo, ratePhotoKb, qc, handleAdvance, advanceOnRate]);

  useEffect(() => {
    if (!photo) return;
    function handleKey(e: KeyboardEvent) {
      // Don't hijack keystrokes while the user is typing in a field (e.g. naming
      // a new collection) — otherwise arrow keys change photo, digits rate it,
      // and "h" hides it, all while they mean to be entering text.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "ArrowLeft" && hasPrev && onPrev) {
        e.preventDefault();
        onPrev();
      } else if (e.key === "ArrowRight" && hasNext && onNext) {
        e.preventDefault();
        onNext();
      } else if ((e.key === "h" || e.key === "H") && caps.isOrgManager) {
        e.preventDefault();
        hideAndAdvanceRef.current();
      } else {
        const digit = parseInt(e.key, 10);
        if (digit >= 1 && digit <= 5) {
          e.preventDefault();
          rateAndAdvanceRef.current(digit);
        }
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [photo, hasPrev, hasNext, onPrev, onNext]);

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
  }

  function handleTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return;
    const deltaX = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(deltaX) < SWIPE_THRESHOLD) return;
    if (deltaX < 0 && hasNext && onNext) {
      onNext();
    } else if (deltaX > 0 && hasPrev && onPrev) {
      onPrev();
    }
  }

  return (
    <DialogPrimitive.Root open={photo !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-black/90 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          onClick={onClose}
        />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 overflow-y-auto overscroll-contain focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          data-testid="photo-lightbox"
          aria-label={photo?.name ?? "Photo preview"}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <DialogPrimitive.Title className="sr-only">
            {photo?.name ?? "Photo preview"}
          </DialogPrimitive.Title>

          <LightboxNavControls
            onClose={onClose}
            onPrev={onPrev}
            onNext={onNext}
            hasPrev={hasPrev}
            hasNext={hasNext}
            isLoadingNext={isLoadingNext}
          />

          {/* Scrollable stage: short viewports (landscape phones, split-screen)
              scroll instead of clipping, and `min-h-full` + centring keeps tall
              screens tidy. Padding reserves room for the nav controls — a top row
              below `lg`, side gutters from `lg` — so they never sit on content. */}
          <div
            className="flex min-h-full items-center justify-center px-4 pb-4 pt-16 lg:px-16 lg:py-6"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
          >
          {photo && (
            <div className="flex flex-col lg:flex-row items-center lg:items-start gap-6 max-w-6xl w-full lg:max-h-[90dvh]">
              <LightboxImageArea
                photo={photo}
                imgSrc={imgSrc}
                imageLoading={imageLoading}
                imageError={imageError}
                aiDescription={fullPhoto?.aiDescription}
                onImageLoad={() => setImageLoading(false)}
                onImageError={() => {
                  setImageLoading(false);
                  setImageError(true);
                }}
              />

              <div
                className="lg:w-64 shrink-0 rounded-xl bg-white/10 backdrop-blur-sm border border-white/15 p-4 space-y-3 lg:max-h-[85dvh] lg:overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
                data-testid="lightbox-sidebar"
              >
                <PhotoSidebarContent
                  photoId={photo.id}
                  albumId={photo.albumId}
                  coverAlbumId={albumId}
                  coverPhotoId={localCoverPhotoId}
                  onAdvance={handleAdvance}
                  advanceOnRate={advanceOnRate}
                  onCoverSet={(newCoverId) => setLocalCoverPhotoId(newCoverId)}
                  onDeleted={(deletedId) => { onDeleted?.(deletedId); onClose(); }}
                  topActions={
                    <>
                      <Link
                        href={`/photos/${photo.id}${detailsQuery ? `?${detailsQuery}` : ""}`}
                        onClick={onClose}
                        className="flex items-center justify-center h-9 w-9 rounded-lg bg-white/15 hover:bg-white/25 border border-white/20 text-white transition-colors"
                        data-testid="lightbox-view-details-link"
                        title="View full details"
                        aria-label="View full details"
                      >
                        <ExternalLink className="h-4 w-4 shrink-0" />
                      </Link>

                      <a
                        href={photo.url}
                        download
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="flex items-center justify-center h-9 w-9 rounded-lg bg-white/15 hover:bg-white/25 border border-white/20 text-white transition-colors"
                        data-testid="lightbox-download"
                        title="Download"
                        aria-label="Download"
                      >
                        <Download className="h-4 w-4 shrink-0" />
                      </a>

                      {onMarkNotApplicable && (
                        <button
                          type="button"
                          onClick={handleMarkNotApplicable}
                          className="flex items-center justify-center h-9 w-9 rounded-lg bg-white/15 hover:bg-destructive/70 border border-white/20 text-white transition-colors"
                          data-testid="lightbox-mark-not-applicable"
                          title="Not applicable — steer this collection's suggestions away from it"
                          aria-label="Not applicable"
                        >
                          <Ban className="h-4 w-4 shrink-0" />
                        </button>
                      )}
                    </>
                  }
                />
              </div>
            </div>
          )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
