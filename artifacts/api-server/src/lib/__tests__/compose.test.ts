import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { compositeLogo, detectPlaceholder, rasterizeLogo, fitInside, defaultBox } from "../imageGeneration/compose";

// Pixel tests for exact-logo composition (#215) with the synthetic fixtures.
// The placeholder in output-with-placeholder.png is at x=780,y=840,w=200,h=120.
const fx = (name: string) => readFileSync(join(__dirname, "fixtures", "fidelity", name));
const withPh = fx("output-with-placeholder.png");
const withoutPh = fx("output-without-placeholder.png");
const logoPng = fx("logo.png");
const logoSvg = fx("logo.svg");

async function raw(buf: Buffer) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}
async function countMagenta(buf: Buffer) {
  const { data } = await raw(buf);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] > 200) n++;
  return n;
}
const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

describe("detectPlaceholder", () => {
  it("finds the key-colour box within 2px", async () => {
    const box = await detectPlaceholder(withPh);
    expect(box).not.toBeNull();
    expect(near(box!.x, 780) && near(box!.y, 840) && near(box!.width, 200) && near(box!.height, 120)).toBe(true);
  });

  it("returns null when there is none", async () => {
    expect(await detectPlaceholder(withoutPh)).toBeNull();
  });

  it("ignores tiny magenta regions", async () => {
    const specks = await sharp(withoutPh)
      .composite([{ input: { create: { width: 6, height: 6, channels: 3, background: "#ff00ff" } }, left: 10, top: 10 }])
      .png()
      .toBuffer();
    expect(await detectPlaceholder(specks)).toBeNull();
  });

  it("tolerates slightly drifted key colour but not a real purple", async () => {
    const drift = await sharp(withoutPh)
      .composite([{ input: { create: { width: 120, height: 80, channels: 3, background: "#f40af0" } }, left: 100, top: 100 }])
      .png()
      .toBuffer();
    expect(await detectPlaceholder(drift)).not.toBeNull();
    const purple = await sharp(withoutPh)
      .composite([{ input: { create: { width: 120, height: 80, channels: 3, background: "#a020a0" } }, left: 100, top: 100 }])
      .png()
      .toBuffer();
    expect(await detectPlaceholder(purple)).toBeNull();
  });
});

describe("compositeLogo", () => {
  it("fills the placeholder: no magenta left and the logo equals the resized source", async () => {
    expect(await countMagenta(withPh)).toBeGreaterThan(20000);
    const r = await compositeLogo(withPh, logoPng, null, { contentType: "image/png" });
    expect(r.placement).toBe("model_placeholder");
    expect(await countMagenta(r.image)).toBe(0);
    // Logo is 200x120 in a 200x120 box: layout equals the box.
    expect(r.layout).toEqual({ x: 780, y: 840, width: 200, height: 120 });

    const meta = await sharp(r.image).metadata();
    expect([meta.width, meta.height]).toEqual([1024, 1024]);

    // Logo region == source logo flattened over the fill colour (small tolerance).
    const region = await sharp(r.image).extract({ left: 780, top: 840, width: 200, height: 120 }).raw().toBuffer();
    const bg = region.subarray(0, 4); // corner of the logo is transparent -> fill colour shows through
    const expected = await sharp(logoPng)
      .flatten({ background: { r: bg[0], g: bg[1], b: bg[2] } })
      .ensureAlpha()
      .raw()
      .toBuffer();
    let maxDiff = 0;
    for (let i = 0; i < expected.length; i++) maxDiff = Math.max(maxDiff, Math.abs(expected[i] - region[i]));
    expect(maxDiff).toBeLessThanOrEqual(6);
  });

  it("fits a different-aspect logo inside the box, centred", async () => {
    const wide = await sharp({ create: { width: 400, height: 100, channels: 4, background: "#00aa00" } }).png().toBuffer();
    const r = await compositeLogo(withPh, wide, null);
    expect(r.layout).toEqual({ x: 780, y: 840 + 35, width: 200, height: 50 });
    expect(await countMagenta(r.image)).toBe(0);
  });

  it("uses the default bottom-right corner when there is no placeholder", async () => {
    const r = await compositeLogo(withoutPh, logoPng, null, { contentType: "image/png" });
    expect(r.placement).toBe("default_corner");
    expect(r.layout).toEqual(defaultBox(1024, 1024, 200, 120));
    expect(r.layout.width).toBe(Math.round(1024 * 0.18));
    // bottom-right with ~4% margin
    expect(r.layout.x + r.layout.width).toBe(1024 - Math.round(1024 * 0.04));
    expect(r.layout.y + r.layout.height).toBe(1024 - Math.round(1024 * 0.04));
    // Pixels outside the logo box are untouched.
    const a = await raw(withoutPh);
    const b = await raw(r.image);
    expect(Buffer.compare(a.data.subarray(0, 4 * 1024 * 100), b.data.subarray(0, 4 * 1024 * 100))).toBe(0);
    // And the logo's red dot pixel is visibly there.
    const px = await sharp(r.image)
      .extract({ left: r.layout.x + Math.round(r.layout.width * 0.26), top: r.layout.y + Math.round(r.layout.height * 0.5), width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect(px[0]).toBeGreaterThan(180);
    expect(px[1]).toBeLessThan(80);
  });

  it("re-composites at a fixed box and keeps the recorded placement", async () => {
    const box = { x: 780, y: 840, width: 200, height: 120 };
    const r = await compositeLogo(withPh, logoPng, box, { placement: "model_placeholder" });
    expect(r.layout).toEqual(box);
    expect(r.placement).toBe("model_placeholder");
    expect(await countMagenta(r.image)).toBe(0);
  });

  it("rasterises an SVG logo at the target size", async () => {
    const png = await rasterizeLogo(logoSvg, "image/svg+xml", { width: 400, height: 240 });
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([400, 240, "png"]);
    const r = await compositeLogo(withPh, logoSvg, null, { contentType: "image/svg+xml" });
    expect(r.layout).toEqual({ x: 780, y: 840, width: 200, height: 120 });
    expect(await countMagenta(r.image)).toBe(0);
    // the SVG's red circle (cx=52, cy=60) lands where expected
    const px = await sharp(r.image).extract({ left: 780 + 52, top: 840 + 60, width: 1, height: 1 }).raw().toBuffer();
    expect(px[0]).toBeGreaterThan(180);
    expect(px[1]).toBeLessThan(80);
  });
});

describe("geometry helpers", () => {
  it("fitInside preserves aspect ratio and centres", () => {
    expect(fitInside({ x: 0, y: 0, width: 100, height: 100 }, 200, 100)).toEqual({ x: 0, y: 25, width: 100, height: 50 });
  });
});
