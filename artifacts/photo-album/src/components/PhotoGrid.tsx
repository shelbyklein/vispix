import * as React from "react";
import { cn } from "@/lib/utils";
import { buildJustifiedRows, effectiveColumns, FALLBACK_ASPECT } from "@/lib/grid-layout";

/**
 * Responsive density counts keyed by Tailwind breakpoint, kept for call sites
 * that don't use the zoom control. `base` applies below `sm` (640px); `sm`
 * applies from 640px; `lg` applies from 1024px.
 */
export interface PhotoGridDensity {
  base: number;
  sm: number;
  lg: number;
}

const DEFAULT_DENSITY: PhotoGridDensity = { base: 2, sm: 3, lg: 4 };

/** Horizontal and vertical gap between photos, matching the old `gap-3`. */
const GAP = 12;

/**
 * Tracks the active density against the Tailwind `sm`/`lg` breakpoints so the
 * row layout can be recomputed on resize.
 */
function useDensity(density: PhotoGridDensity): number {
  const resolve = React.useCallback(() => {
    if (typeof window === "undefined" || !window.matchMedia) return density.base;
    if (window.matchMedia("(min-width: 1024px)").matches) return density.lg;
    if (window.matchMedia("(min-width: 640px)").matches) return density.sm;
    return density.base;
  }, [density]);

  const [count, setCount] = React.useState(resolve);

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const queries = [
      window.matchMedia("(min-width: 640px)"),
      window.matchMedia("(min-width: 1024px)"),
    ];
    const update = () => setCount(resolve());
    update();
    queries.forEach((q) => q.addEventListener("change", update));
    return () => queries.forEach((q) => q.removeEventListener("change", update));
  }, [resolve]);

  return count;
}

/** Observes the grid container's content width. */
function useContainerWidth(): [React.RefCallback<HTMLDivElement>, number | null] {
  const [width, setWidth] = React.useState<number | null>(null);
  const observerRef = React.useRef<ResizeObserver | null>(null);

  const ref = React.useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;
    setWidth(node.clientWidth);
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect.width;
        if (w) setWidth(w);
      });
      observer.observe(node);
      observerRef.current = observer;
    }
  }, []);

  return [ref, width];
}

export interface PhotoGridProps<T> {
  items: T[];
  /** Stable key per item (used so images don't reload when rows reflow). */
  getKey: (item: T) => React.Key;
  /** Render one item. The item fills a wrapper sized to the justified cell. */
  renderItem: (item: T, index: number) => React.ReactNode;
  /**
   * Aspect ratio (width / height) per item. Defaults to reading `width` and
   * `height` off the item (photo API responses carry them); items without
   * known dimensions assume 3:2 until the dimension backfill fills them in.
   */
  getAspectRatio?: (item: T) => number | null | undefined;
  density?: PhotoGridDensity;
  /**
   * Fixed density that overrides the responsive `density` at every breakpoint.
   * Wired to the grid zoom control (3-8): higher means more photos per row.
   */
  densityOverride?: number;
  className?: string;
  "data-testid"?: string;
}

function defaultAspectRatio(item: unknown): number | null {
  if (item && typeof item === "object") {
    const { width, height } = item as { width?: unknown; height?: unknown };
    if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
      return width / height;
    }
  }
  return null;
}

interface Row<T> {
  cells: { item: T; index: number; width: number }[];
  height: number;
}

/**
 * Justified photo grid (Google Photos style): photos read left-to-right in
 * rows, every photo in a row shares the row's height, and photos keep their
 * real aspect ratio — never cropped. Rows are built greedily against a target
 * height derived from the density (photos-per-row at a nominal 3:2 aspect),
 * then scaled so each row exactly fills the container width. The final row
 * renders at the target height instead of being stretched to fit.
 */
export function PhotoGrid<T>({
  items,
  getKey,
  renderItem,
  getAspectRatio,
  density = DEFAULT_DENSITY,
  densityOverride,
  className,
  "data-testid": testId,
}: PhotoGridProps<T>) {
  const responsiveDensity = useDensity(density);
  const preferred = densityOverride && densityOverride > 0 ? densityOverride : responsiveDensity;
  const [containerRef, containerWidth] = useContainerWidth();
  // The preference is a ceiling: narrow containers (small windows, the docked
  // side panel) get fewer columns so tiles stay legible. Recomputed on every
  // resize; the stored zoom is never touched.
  const perRow = containerWidth ? effectiveColumns(preferred, containerWidth, GAP) : preferred;

  const rows: Row<T>[] = React.useMemo(() => {
    if (!containerWidth || containerWidth <= 0 || items.length === 0) return [];
    const aspects = items.map((item) => {
      const a = (getAspectRatio ?? defaultAspectRatio)(item);
      return a && a > 0 ? a : FALLBACK_ASPECT;
    });
    return buildJustifiedRows(aspects, containerWidth, perRow, GAP).map((row) => ({
      height: row.height,
      cells: row.cells.map(({ index, width }) => ({ item: items[index], index, width })),
    }));
  }, [items, containerWidth, perRow, getAspectRatio]);

  return (
    <div ref={containerRef} className={cn("flex flex-col", className)} data-testid={testId} style={{ gap: GAP }}>
      {rows.map((row, rowIndex) => (
        <div key={rowIndex} className="flex" style={{ gap: GAP }}>
          {row.cells.map(({ item, index, width }) => (
            // Fixed cell size (not just width): rows keep their height before
            // images load, so lazy loading causes no layout shift. Item markup
            // should fill the cell (h-full + object-cover images).
            <div key={getKey(item)} className="min-w-0 shrink-0" style={{ width, height: row.height }}>
              {renderItem(item, index)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
