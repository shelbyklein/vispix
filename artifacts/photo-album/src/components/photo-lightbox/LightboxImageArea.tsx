import { Star, Loader2, ImageOff, Bot } from "lucide-react";
import { FadeImage } from "@/components/ui/fade-image";
import type { LightboxPhoto } from "./types";

export function LightboxImageArea({
  photo,
  imgSrc,
  imageLoading,
  imageError,
  aiDescription,
  onImageLoad,
  onImageError,
}: {
  photo: LightboxPhoto;
  imgSrc: string | undefined;
  imageLoading: boolean;
  imageError: boolean;
  aiDescription?: string | null;
  onImageLoad: () => void;
  onImageError: () => void;
}) {
  return (
    <div className="flex-1 flex flex-col items-center gap-3 min-w-0 overflow-hidden">
      <div className="relative flex items-center justify-center max-h-[65dvh] lg:max-h-[80dvh] w-full">
        {imageLoading && !imageError && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <Loader2 className="h-10 w-10 text-white/60 animate-spin" />
          </div>
        )}
        {imageError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10 text-white/60" data-testid="lightbox-image-error">
            <ImageOff className="h-10 w-10" />
            <span className="text-sm">Failed to load image</span>
          </div>
        )}
        <FadeImage
          key={photo.id}
          src={imgSrc!}
          alt={photo.name ?? "Photo"}
          fit="contain"
          className="max-h-[65dvh] lg:max-h-[80dvh] max-w-full rounded-lg object-contain shadow-2xl"
          onLoad={onImageLoad}
          onError={onImageError}
          data-testid="lightbox-image"
        />
      </div>

      <div className="flex items-center gap-3">
        {photo.name && (
          <span className="text-white font-medium text-sm" data-testid="lightbox-name">
            {photo.name}
          </span>
        )}
        {photo.averageRating != null && (
          <div className="flex items-center gap-1" data-testid="lightbox-rating">
            <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
            <span className="text-amber-400 font-semibold text-sm">
              {photo.averageRating.toFixed(1)}
            </span>
          </div>
        )}
      </div>

      {aiDescription && (
        <div className="mx-auto max-w-2xl text-left" data-testid="lightbox-ai-description">
          <div className="mb-1 flex items-center gap-1.5 text-white/60">
            <Bot className="h-3.5 w-3.5 text-sky-300" />
            <span className="text-xs font-semibold uppercase tracking-wide">AI Description</span>
          </div>
          <p className="text-sm leading-relaxed text-white/75">{aiDescription}</p>
        </div>
      )}
    </div>
  );
}
