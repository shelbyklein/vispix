import { useState } from "react";
import { useRatePhoto, useClearPhotoRating } from "@workspace/api-client-react";
import { Star } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export function StarRating({ photoId, myRating, currentUserId, onRated }: {
  photoId: number;
  myRating?: number | null;
  currentUserId?: number;
  onRated: () => void;
}) {
  const [hovered, setHovered] = useState(0);
  const { mutate: ratePhoto, isPending } = useRatePhoto();
  const { mutate: clearRating, isPending: isClearing } = useClearPhotoRating();
  const { toast } = useToast();

  const isSignedIn = currentUserId != null;
  const interactive = isSignedIn;
  const displayRating = hovered || myRating || 0;

  function handleClear() {
    clearRating(
      { id: photoId },
      {
        onSuccess: () => {
          onRated();
          toast({ title: "Rating cleared" });
        },
        onError: () => toast({ title: "Failed to clear rating", variant: "destructive" }),
      }
    );
  }

  function handleRate(score: number) {
    if (!isSignedIn) {
      toast({ title: "Sign in to rate photos", variant: "destructive" });
      return;
    }
    ratePhoto(
      { id: photoId, data: { score } },
      {
        onSuccess: () => {
          onRated();
          toast({ title: `Rated ${score} star${score !== 1 ? "s" : ""}` });
        },
        onError: () => toast({ title: "Failed to submit rating", variant: "destructive" }),
      }
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3" data-testid="rating-section">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">Rate this photo</h2>
        <p className="text-xs text-muted-foreground">
          {!isSignedIn
            ? "Sign in to give this photo a rating from 1 to 5 stars."
            : myRating != null
              ? "Tap a star to update your rating."
              : "Tap a star to rate from 1 (lowest) to 5 (highest)."}
        </p>
      </div>
      <div className="flex items-center gap-1.5" data-testid="star-rating">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type="button"
            onClick={() => handleRate(star)}
            onMouseEnter={() => interactive && setHovered(star)}
            onMouseLeave={() => interactive && setHovered(0)}
            disabled={isPending || isClearing || !interactive}
            aria-label={`Rate ${star} star${star !== 1 ? "s" : ""}`}
            aria-pressed={myRating === star}
            className={
              interactive
                ? "p-1 rounded-md transition-all hover:scale-110 hover:bg-warning/10 focus:outline-none focus:ring-2 focus:ring-warning disabled:cursor-not-allowed"
                : "p-1 rounded-md cursor-not-allowed"
            }
            data-testid={`star-${star}`}
          >
            <Star
              className={
                displayRating >= star
                  ? "h-7 w-7 fill-amber-400 text-amber-400"
                  : interactive
                    ? "h-7 w-7 text-muted-foreground/70 stroke-[1.75]"
                    : "h-7 w-7 text-muted-foreground/40 stroke-[1.75]"
              }
            />
          </button>
        ))}
        {myRating != null && (
          <span className="text-sm font-medium text-foreground ml-2" data-testid="my-rating-text">
            Your rating: {myRating}/5
          </span>
        )}
      </div>
      {interactive && myRating != null && (
        <button
          type="button"
          onClick={handleClear}
          disabled={isPending || isClearing}
          className="text-xs font-medium text-muted-foreground hover:text-foreground underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="clear-rating"
        >
          Clear rating
        </button>
      )}
    </div>
  );
}
