import { useEffect, useRef, useState } from "react";
import { useListPhotos } from "@workspace/api-client-react";
import { ImagePlus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { extractPalette, PALETTE_SIZE } from "./engine";

const MAX_SIDE = 256;

/** Draw an image (same-origin, data or blob URL) into a small canvas and extract its dominant colors. */
function colorsFromUrl(src: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("Canvas is not available in this browser.");
        ctx.drawImage(img, 0, 0, w, h);
        const colors = extractPalette(ctx.getImageData(0, 0, w, h).data, PALETTE_SIZE);
        if (colors.length === 0) throw new Error("No colors found in this image.");
        resolve(colors);
      } catch (e) {
        reject(e instanceof Error ? e : new Error("Could not read the image."));
      }
    };
    img.onerror = () => reject(new Error("The image could not be loaded."));
    img.src = src;
  });
}

export function ImageSource({
  onExtracted,
}: {
  onExtracted: (colors: string[]) => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const blobRef = useRef<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => () => {
    if (blobRef.current) URL.revokeObjectURL(blobRef.current);
  }, []);

  const params = { limit: 18, ...(debounced ? { search: debounced } : {}) };
  const { data, isLoading, error: listError } = useListPhotos(params);

  async function run(src: string, previewSrc: string) {
    setBusy(true);
    setError(null);
    try {
      const colors = await colorsFromUrl(src);
      setPreview(previewSrc);
      onExtracted(colors);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the image.");
    } finally {
      setBusy(false);
    }
  }

  function onFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Choose an image file (JPEG, PNG, WebP, GIF).");
      return;
    }
    if (blobRef.current) URL.revokeObjectURL(blobRef.current);
    const url = URL.createObjectURL(file);
    blobRef.current = url;
    void run(url, url);
  }

  return (
    <div className="space-y-3" data-testid="palette-image-source">
      <div className="flex flex-wrap items-center gap-3">
        <input ref={fileRef} type="file" accept="image/*" className="sr-only" tabIndex={-1} onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} data-testid="palette-image-file" />
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
          <ImagePlus className="mr-1.5 h-3.5 w-3.5" /> Upload an image
        </Button>
        <span className="text-xs text-muted-foreground">or pick one from your library. The image stays in your browser.</span>
      </div>

      {preview && (
        <img src={preview} alt="Image the colors were taken from" className="h-24 w-full rounded-lg object-cover ring-1 ring-border" data-testid="palette-image-preview" />
      )}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}

      <div className="space-y-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your library" className="pl-8" aria-label="Search library photos" data-testid="palette-library-search" />
        </div>
        {isLoading ? (
          <div className="grid grid-cols-6 gap-1.5">
            {Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="aspect-square rounded-md" />)}
          </div>
        ) : listError ? (
          <p className="text-xs text-destructive">Could not load photos: {(listError as Error).message}</p>
        ) : data && data.photos.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            {debounced ? `No photos match "${debounced}".` : "No photos in your library yet."}
          </p>
        ) : (
          <ul className="grid grid-cols-6 gap-1.5" data-testid="palette-library-grid">
            {data?.photos.map((p) => {
              const src = p.thumbnailKey ? `/api/storage${p.thumbnailKey}` : p.url;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(src, src)}
                    className="group block aspect-square w-full overflow-hidden rounded-md outline-none ring-1 ring-border focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                    aria-label={`Take colors from ${p.filename ?? `photo ${p.id}`}`}
                    data-testid={`palette-library-photo-${p.id}`}
                  >
                    <img src={src} alt="" loading="lazy" className="h-full w-full object-cover transition-transform group-hover:scale-105" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
