// Pure layout maths for the justified photo grid, kept free of React/DOM so it
// can be unit-tested (#219).

/** Smallest nominal tile width (px) a grid may render, however dense the preference. */
export const MIN_TILE_WIDTH = 96;

/** Aspect ratio assumed for photos whose dimensions aren't (yet) known. */
export const FALLBACK_ASPECT = 3 / 2;

/**
 * Columns actually used: the user's preferred density, capped so a nominal tile
 * never drops below `minTileWidth` in a narrow container. The preference itself
 * is never modified, so widening the container (or closing a side panel)
 * restores the full density.
 */
export function effectiveColumns(
  preferred: number,
  containerWidth: number,
  gap: number,
  minTileWidth: number = MIN_TILE_WIDTH,
): number {
  const pref = Math.max(1, Math.round(preferred));
  if (!(containerWidth > 0)) return pref;
  const fit = Math.max(1, Math.floor((containerWidth + gap) / (minTileWidth + gap)));
  return Math.min(pref, fit);
}

export interface JustifiedRow {
  /** Indexes into the input aspect list, with each cell's rendered width. */
  cells: { index: number; width: number }[];
  height: number;
}

/**
 * Greedy justified rows against a target height derived from `perRow`
 * nominal-3:2 tiles. Rows are scaled to fill `containerWidth`; the last row
 * keeps the target height. A row is also closed early when adding another photo
 * would squeeze any cell below `minTileWidth` (e.g. a run of portrait photos).
 */
export function buildJustifiedRows(
  aspects: number[],
  containerWidth: number,
  perRow: number,
  gap: number,
  minTileWidth: number = MIN_TILE_WIDTH,
): JustifiedRow[] {
  if (!(containerWidth > 0) || aspects.length === 0) return [];
  const targetHeight = (containerWidth - gap * (perRow - 1)) / (perRow * FALLBACK_ASPECT);

  const rows: JustifiedRow[] = [];
  let current: { index: number; aspect: number }[] = [];
  let aspectSum = 0;
  let minAspect = Infinity;

  const closeRow = (justify: boolean) => {
    if (current.length === 0) return;
    const gaps = gap * (current.length - 1);
    const justified = (containerWidth - gaps) / aspectSum;
    // The unjustified last row may grow past the target just enough to keep
    // its narrowest photo at the minimum width.
    const height = justify ? justified : Math.min(justified, Math.max(targetHeight, minTileWidth / minAspect));
    rows.push({
      cells: current.map(({ index, aspect }) => ({ index, width: aspect * height })),
      height,
    });
    current = [];
    aspectSum = 0;
    minAspect = Infinity;
  };

  aspects.forEach((aspect, index) => {
    if (current.length > 0) {
      const nextHeight = (containerWidth - gap * current.length) / (aspectSum + aspect);
      if (Math.min(minAspect, aspect) * nextHeight < minTileWidth) closeRow(true);
    }
    current.push({ index, aspect });
    aspectSum += aspect;
    minAspect = Math.min(minAspect, aspect);
    if (aspectSum * targetHeight + gap * (current.length - 1) >= containerWidth) closeRow(true);
  });
  closeRow(false);
  return rows;
}
