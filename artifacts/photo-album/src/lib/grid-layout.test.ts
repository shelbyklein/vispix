import { describe, expect, it } from "vitest";
import { buildJustifiedRows, effectiveColumns, MIN_TILE_WIDTH } from "./grid-layout";

const GAP = 12;

describe("effectiveColumns", () => {
  it("keeps the preference when the container is wide enough", () => {
    expect(effectiveColumns(8, 1400, GAP)).toBe(8);
    expect(effectiveColumns(3, 1400, GAP)).toBe(3);
  });

  it("caps the preference so tiles stay above the minimum width", () => {
    // 400px container: floor((400+12)/(96+12)) = 3 columns.
    expect(effectiveColumns(8, 400, GAP)).toBe(3);
    expect(effectiveColumns(2, 400, GAP)).toBe(2);
  });

  it("never returns fewer than one column", () => {
    expect(effectiveColumns(5, 40, GAP)).toBe(1);
  });

  it("returns the preference while the width is unknown", () => {
    expect(effectiveColumns(6, 0, GAP)).toBe(6);
  });

  it("restores the full preference when the container widens again", () => {
    expect(effectiveColumns(6, 300, GAP)).toBeLessThan(6);
    expect(effectiveColumns(6, 1200, GAP)).toBe(6);
  });
});

describe("buildJustifiedRows", () => {
  it("fills each full row exactly", () => {
    const rows = buildJustifiedRows(Array(12).fill(1.5), 800, 4, GAP);
    for (const row of rows.slice(0, -1)) {
      const total = row.cells.reduce((s, c) => s + c.width, 0) + GAP * (row.cells.length - 1);
      expect(total).toBeCloseTo(800, 3);
    }
  });

  it("keeps every cell at or above the minimum width, even for portraits", () => {
    const aspects = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? 0.56 : i % 3 === 1 ? 0.75 : 1.5));
    for (const [width, perRow] of [[400, 3], [800, 8], [1200, 8]] as const) {
      const rows = buildJustifiedRows(aspects, width, perRow, GAP);
      for (const row of rows) {
        for (const cell of row.cells) expect(cell.width).toBeGreaterThanOrEqual(MIN_TILE_WIDTH - 0.001);
      }
    }
  });

  it("returns no rows for an empty list or zero width", () => {
    expect(buildJustifiedRows([], 800, 4, GAP)).toEqual([]);
    expect(buildJustifiedRows([1], 0, 4, GAP)).toEqual([]);
  });
});
