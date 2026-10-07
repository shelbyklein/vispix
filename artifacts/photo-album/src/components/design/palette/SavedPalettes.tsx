import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { SavedPalette } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PaletteStrip } from "./Swatches";

export function SavedPalettes({
  palettes,
  isLoading,
  error,
  loadedId,
  onOpen,
  onDelete,
}: {
  palettes: SavedPalette[] | undefined;
  isLoading: boolean;
  error: Error | null;
  loadedId: number | null;
  onOpen: (p: SavedPalette) => void;
  onDelete: (p: SavedPalette) => Promise<void>;
}) {
  const [pending, setPending] = useState<SavedPalette | null>(null);

  return (
    <div className="space-y-2" data-testid="palette-saved-list">
      <h3 className="text-sm font-semibold">Saved palettes</h3>
      {isLoading ? (
        <Skeleton className="h-14 w-full rounded-lg" />
      ) : error ? (
        <p className="text-xs text-destructive">Could not load saved palettes: {error.message}</p>
      ) : !palettes || palettes.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">No saved palettes yet. Name this one and save it.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {palettes.map((p) => (
            <li key={p.id} className={`space-y-2 rounded-lg border p-2.5 ${p.id === loadedId ? "border-foreground" : "border-border"}`} data-testid={`palette-saved-${p.id}`}>
              <PaletteStrip swatches={p.swatches} className="h-6" />
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground">Updated {new Date(p.updatedAt).toLocaleDateString()}</div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button type="button" variant="outline" size="sm" onClick={() => onOpen(p)}>Open</Button>
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={`Delete ${p.name}`} onClick={() => setPending(p)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <AlertDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{pending?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>The saved palette is removed for everyone. The theme is not affected.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                const p = pending;
                setPending(null);
                if (p) await onDelete(p);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
