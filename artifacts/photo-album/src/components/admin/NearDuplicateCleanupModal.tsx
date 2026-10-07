import { useEffect, useState } from "react";
import type { NearDuplicateGroup, NearDuplicateModalPhoto } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Loader2, Trash2, EyeOff, Layers, ArrowLeft, ArrowRight, CheckCircle2, X, Star, FolderOpen } from "lucide-react";
import { formatDate } from "@/lib/format-date";
import { cn } from "@/lib/utils";
import { HashDiffGrid, hammingDistance } from "@/components/admin/HashDiffGrid";

// Interactive near-duplicates cleanup (issues #123/#124/#125): steps through
// each comparison with the images side by side; per-photo delete, per-
// comparison Ignore (persisted server-side), and for two-photo comparisons a
// Diff overlay that superimposes the images with an opacity blend.
export function NearDuplicateCleanupModal({
  open,
  onOpenChange,
  groups,
  onDeletePhoto,
  onIgnoreGroup,
  isDeleting,
  isIgnoring,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: NearDuplicateGroup[];
  onDeletePhoto: (id: number) => void;
  onIgnoreGroup: (group: NearDuplicateGroup) => void;
  isDeleting: boolean;
  isIgnoring: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [diffMode, setDiffMode] = useState(false);
  const [blend, setBlend] = useState(50);

  // Groups shrink as comparisons are resolved (deleted below 2 photos, or
  // ignored) — clamp the cursor and drop diff mode when the group changes.
  const clamped = Math.min(index, Math.max(groups.length - 1, 0));
  const group = groups[clamped];
  useEffect(() => {
    if (index !== clamped) setIndex(clamped);
  }, [index, clamped]);
  useEffect(() => {
    setDiffMode(false);
    setBlend(50);
  }, [group?.key]);
  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  const done = groups.length === 0;
  const photos = (group?.photos ?? []) as NearDuplicateModalPhoto[];
  const isPair = photos.length === 2;

  // Hash similarity for pairs (#129): the exact bit distance between the two
  // dHashes, rendered as a percentage plus a bit-grid visualization.
  const pairDistance =
    isPair && photos[0].perceptualHash && photos[1].perceptualHash
      ? hammingDistance(photos[0].perceptualHash, photos[1].perceptualHash)
      : null;
  const similarity = pairDistance != null ? Math.round(((64 - pairDistance) / 64) * 100) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[92dvh] overflow-y-auto" data-testid="cleanup-modal">
        <DialogHeader>
          <DialogTitle>Interactive cleanup</DialogTitle>
          <DialogDescription>
            {done
              ? "All comparisons resolved."
              : `Comparison ${clamped + 1} of ${groups.length} — delete the copies you don't need, or ignore the comparison if they're not duplicates.`}
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="py-12 text-center space-y-3" data-testid="cleanup-done">
            <CheckCircle2 className="h-10 w-10 mx-auto text-success-foreground" />
            <p className="text-sm text-muted-foreground">Nothing left to review.</p>
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Close</Button>
          </div>
        ) : diffMode && isPair ? (
          /* Diff overlay (#125): both images superimposed; the slider blends
             between them so subtle differences pop. */
          <div className="space-y-3" data-testid="diff-overlay">
            <div className="relative mx-auto w-full max-w-2xl aspect-[4/3] bg-black/90 rounded-lg overflow-hidden">
              <img
                src={photos[0].imageUrl}
                alt={photos[0].filename ?? "photo A"}
                className="absolute inset-0 h-full w-full object-contain"
              />
              <img
                src={photos[1].imageUrl}
                alt={photos[1].filename ?? "photo B"}
                className="absolute inset-0 h-full w-full object-contain"
                style={{ opacity: blend / 100 }}
              />
            </div>
            <div className="flex items-center gap-3 max-w-2xl mx-auto">
              <span className="text-xs text-muted-foreground truncate max-w-32">{photos[0].filename ?? "A"}</span>
              <Slider
                value={[blend]}
                onValueChange={([v]) => setBlend(v)}
                min={0}
                max={100}
                step={1}
                className="flex-1"
                data-testid="diff-blend-slider"
              />
              <span className="text-xs text-muted-foreground truncate max-w-32 text-right">{photos[1].filename ?? "B"}</span>
            </div>
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={() => setDiffMode(false)} data-testid="diff-close-btn">
                <X className="h-4 w-4 mr-1.5" /> Back to side-by-side
              </Button>
            </div>
          </div>
        ) : (
          <>
          {similarity != null && photos[0].perceptualHash && photos[1].perceptualHash && (
            /* Hash similarity readout (#129): percentage + which of the 64
               perceptual-hash bits actually differ. */
            <div className="rounded-lg border border-border bg-muted/40 px-4 py-2.5 flex flex-wrap items-center justify-between gap-3" data-testid="hash-similarity">
              <span className="text-sm">
                <span className={cn("font-semibold", similarity >= 95 ? "text-red-600 dark:text-red-500" : "text-foreground")}>
                  ≈{similarity}% similar
                </span>{" "}
                <span className="text-muted-foreground">
                  — {pairDistance} of 64 perceptual-hash bits differ{pairDistance === 0 ? " (visually identical)" : ""}
                </span>
              </span>
              <HashDiffGrid hashA={photos[0].perceptualHash} hashB={photos[1].perceptualHash} />
            </div>
          )}
          {/* Side-by-side review (#123). */}
          <div
            className={cn("grid gap-3", photos.length <= 2 ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3")}
            data-testid="cleanup-compare"
          >
            {photos.map((p) => (
              <div key={p.id} className="rounded-lg border border-border overflow-hidden bg-card flex flex-col">
                <div className="aspect-[4/3] bg-black/90">
                  <img src={p.imageUrl} alt={p.filename ?? `photo ${p.id}`} className="h-full w-full object-contain" />
                </div>
                <div className="p-3 space-y-1 text-xs flex-1">
                  <p className="font-medium text-foreground truncate">{p.filename ?? `Photo #${p.id}`}</p>
                  <p className="text-muted-foreground truncate">
                    {p.albumTitle ?? "No album"} · {formatDate(p.createdAt)}
                  </p>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    {p.isAlbumCover && (
                      <span className="inline-flex items-center gap-0.5"><Star className="h-3 w-3" /> Album cover</span>
                    )}
                    {p.collectionCount > 0 && (
                      <span className="inline-flex items-center gap-0.5">
                        <FolderOpen className="h-3 w-3" /> {p.collectionCount} collection{p.collectionCount !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>
                <div className="p-3 pt-0">
                  {p.isAlbumCover ? (
                    <Button variant="outline" size="sm" className="w-full" disabled title="Album covers can't be deleted">
                      <Star className="h-3.5 w-3.5 mr-1.5" /> Album cover — protected
                    </Button>
                  ) : (
                    <Button
                      variant="destructive"
                      size="sm"
                      className="w-full"
                      disabled={isDeleting}
                      onClick={() => onDeletePhoto(p.id)}
                      data-testid={`cleanup-delete-${p.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete this one
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
          </>
        )}

        {!done && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={clamped === 0}
                onClick={() => setIndex(clamped - 1)}
                data-testid="cleanup-prev"
              >
                <ArrowLeft className="h-4 w-4 mr-1" /> Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={clamped >= groups.length - 1}
                onClick={() => setIndex(clamped + 1)}
                data-testid="cleanup-next"
              >
                Skip <ArrowRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
            <div className="flex items-center gap-2">
              {isPair && !diffMode && (
                <Button variant="outline" size="sm" onClick={() => setDiffMode(true)} data-testid="cleanup-diff-btn">
                  <Layers className="h-4 w-4 mr-1.5" /> Diff
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={isIgnoring}
                onClick={() => group && onIgnoreGroup(group)}
                data-testid="cleanup-ignore-btn"
              >
                {isIgnoring ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <EyeOff className="h-4 w-4 mr-1.5" />}
                Ignore — not duplicates
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
