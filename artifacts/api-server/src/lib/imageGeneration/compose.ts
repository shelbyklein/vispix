import sharp from "sharp";

// Exact-logo composition (#215, docs/IMAGE_FIDELITY.md). The model is asked to
// leave a flat #FF00FF rectangle where the logo belongs; Vispix finds it and
// composites the original logo file there, so the logo is never redrawn.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Placement = "model_placeholder" | "default_corner";

/** Key colour the model is told to paint the placeholder with. */
export const PLACEHOLDER_RGB = [255, 0, 255] as const;
export const PLACEHOLDER_HEX = "#FF00FF";

/**
 * A pixel belongs to the placeholder when its Euclidean RGB distance to
 * #FF00FF is at most this. Image models rarely return a perfectly flat fill
 * (slight banding / compression drift), so exact matching is too strict; 80 is
 * wide enough for that drift yet excludes real magentas/purples such as
 * (200,60,200) (distance ~96).
 */
export const PLACEHOLDER_TOLERANCE = 80;
/**
 * Looser tolerance used only to clear anti-aliased edge pixels around a
 * detected placeholder (inside its box expanded by EDGE_PAD) so no magenta
 * fringe survives under the logo.
 */
export const EDGE_TOLERANCE = 150;
export const EDGE_PAD = 3;
/** Regions smaller than this share of the canvas are noise, not a placeholder. */
export const MIN_REGION_FRACTION = 0.002;

/** Default position: bottom-right, this share of the canvas width, with a margin. */
export const DEFAULT_WIDTH_FRACTION = 0.18;
export const DEFAULT_MARGIN_FRACTION = 0.04;
/** The default logo never takes more than this share of the canvas height. */
export const DEFAULT_MAX_HEIGHT_FRACTION = 0.3;

function dist2(r: number, g: number, b: number): number {
  const dr = r - PLACEHOLDER_RGB[0];
  const dg = g - PLACEHOLDER_RGB[1];
  const db = b - PLACEHOLDER_RGB[2];
  return dr * dr + dg * dg + db * db;
}

async function rawRgba(png: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Largest 4-connected region of pixels within PLACEHOLDER_TOLERANCE of
 * #FF00FF, as its bounding box; null when none reaches MIN_REGION_FRACTION of
 * the canvas.
 */
export async function detectPlaceholder(png: Buffer): Promise<Box | null> {
  const { data, width, height } = await rawRgba(png);
  return detectInRaw(data, width, height);
}

function detectInRaw(data: Buffer, width: number, height: number): Box | null {
  const total = width * height;
  const tol2 = PLACEHOLDER_TOLERANCE * PLACEHOLDER_TOLERANCE;
  const mask = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    if (data[o + 3] > 127 && dist2(data[o], data[o + 1], data[o + 2]) <= tol2) mask[i] = 1;
  }
  const minArea = Math.max(1, Math.floor(total * MIN_REGION_FRACTION));
  let best: (Box & { area: number }) | null = null;
  const stack = new Int32Array(total);
  for (let start = 0; start < total; start++) {
    if (mask[start] !== 1) continue;
    let sp = 0;
    stack[sp++] = start;
    mask[start] = 2;
    let area = 0;
    let minX = width, minY = height, maxX = 0, maxY = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % width;
      const y = (p - x) / width;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] === 1) { mask[p - 1] = 2; stack[sp++] = p - 1; }
      if (x < width - 1 && mask[p + 1] === 1) { mask[p + 1] = 2; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - width] === 1) { mask[p - width] = 2; stack[sp++] = p - width; }
      if (y < height - 1 && mask[p + width] === 1) { mask[p + width] = 2; stack[sp++] = p + width; }
    }
    if (area >= minArea && (!best || area > best.area)) {
      best = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, area };
    }
  }
  return best ? { x: best.x, y: best.y, width: best.width, height: best.height } : null;
}

/** True when the bytes are an SVG document (by content, not by declared type). */
export async function isSvg(file: Buffer, contentType?: string): Promise<boolean> {
  if (contentType?.toLowerCase().startsWith("image/svg")) return true;
  const head = file.subarray(0, 1024).toString("utf8").toLowerCase();
  return head.includes("<svg");
}

/** Natural pixel size of a logo file (SVG: its intrinsic size). */
export async function logoDimensions(file: Buffer, contentType?: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(file, (await isSvg(file, contentType)) ? { density: 96 } : undefined).metadata();
  if (!meta.width || !meta.height) throw new Error("Logo has no readable dimensions.");
  return { width: meta.width, height: meta.height };
}

/**
 * Logo as PNG ready to composite. PNG/JPG/WebP are used as-is (decoded and
 * re-encoded losslessly, optionally scaled to `target`); SVG is rendered by
 * sharp directly at the target size so it stays crisp.
 */
export async function rasterizeLogo(
  file: Buffer,
  contentType?: string,
  target?: { width: number; height: number },
): Promise<Buffer> {
  if (await isSvg(file, contentType)) {
    const natural = await logoDimensions(file, contentType);
    const w = target?.width ?? natural.width;
    // Oversample the vector render density so the requested size is sharp.
    const density = Math.min(2400, Math.max(72, Math.ceil((72 * w) / natural.width) * 2));
    return sharp(file, { density })
      .resize(w, target?.height ?? natural.height, { fit: "fill" })
      .png()
      .toBuffer();
  }
  let img = sharp(file);
  if (target) img = img.resize(target.width, target.height, { fit: "fill", kernel: "lanczos3" });
  return img.ensureAlpha().png().toBuffer();
}

/** Fit `lw x lh` inside `box`, preserving aspect ratio, centred. */
export function fitInside(box: Box, lw: number, lh: number): Box {
  const scale = Math.min(box.width / lw, box.height / lh);
  const width = Math.max(1, Math.round(lw * scale));
  const height = Math.max(1, Math.round(lh * scale));
  return {
    x: Math.round(box.x + (box.width - width) / 2),
    y: Math.round(box.y + (box.height - height) / 2),
    width,
    height,
  };
}

/** Default bottom-right box for a logo of the given aspect on a canvas. */
export function defaultBox(canvasW: number, canvasH: number, lw: number, lh: number): Box {
  const margin = Math.round(canvasW * DEFAULT_MARGIN_FRACTION);
  let width = Math.round(canvasW * DEFAULT_WIDTH_FRACTION);
  let height = Math.round((width * lh) / lw);
  const maxH = Math.round(canvasH * DEFAULT_MAX_HEIGHT_FRACTION);
  if (height > maxH) {
    height = maxH;
    width = Math.round((height * lw) / lh);
  }
  return { x: Math.max(0, canvasW - margin - width), y: Math.max(0, canvasH - margin - height), width, height };
}

function clampBox(b: Box, w: number, h: number): Box {
  const x = Math.min(Math.max(0, b.x), w - 1);
  const y = Math.min(Math.max(0, b.y), h - 1);
  return { x, y, width: Math.max(1, Math.min(b.width, w - x)), height: Math.max(1, Math.min(b.height, h - y)) };
}

/** Median colour of a ring of pixels just outside `box`, ignoring magenta-ish pixels. */
function ringColour(data: Buffer, width: number, height: number, box: Box): [number, number, number] {
  const gap = EDGE_PAD + 1;
  const thick = 4;
  const x0 = Math.max(0, box.x - gap - thick), x1 = Math.min(width - 1, box.x + box.width - 1 + gap + thick);
  const y0 = Math.max(0, box.y - gap - thick), y1 = Math.min(height - 1, box.y + box.height - 1 + gap + thick);
  const ix0 = box.x - gap, ix1 = box.x + box.width - 1 + gap;
  const iy0 = box.y - gap, iy1 = box.y + box.height - 1 + gap;
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const tol2 = EDGE_TOLERANCE * EDGE_TOLERANCE;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x >= ix0 && x <= ix1 && y >= iy0 && y <= iy1) continue; // inside the exclusion zone
      const o = (y * width + x) * 4;
      if (dist2(data[o], data[o + 1], data[o + 2]) <= tol2) continue;
      rs.push(data[o]); gs.push(data[o + 1]); bs.push(data[o + 2]);
    }
  }
  const med = (a: number[]) => (a.length ? a.sort((p, q) => p - q)[a.length >> 1] : 255);
  return [med(rs), med(gs), med(bs)];
}

export interface CompositeResult {
  image: Buffer;
  /** Pixel box of the logo on the final image. */
  layout: Box;
  placement: Placement;
}

/**
 * Composite the original logo onto `base`.
 *
 * - `box` given (revision re-composite): the logo is fitted into that box;
 *   `opts.placement` carries the parent's placement forward.
 * - `box` null: the model's placeholder is detected; when found the logo is
 *   fitted into it (`model_placeholder`), otherwise it goes bottom-right
 *   (`default_corner`).
 *
 * Whenever a placeholder is present in `base` (detected here, even if the logo
 * goes elsewhere) its pixels are filled with the surrounding colour first, so
 * no magenta remains in the result. (Other magenta-ish regions elsewhere in the
 * image are real content and are left alone.)
 */
export async function compositeLogo(
  base: Buffer,
  logo: Buffer,
  box: Box | null,
  opts: { contentType?: string; placement?: Placement } = {},
): Promise<CompositeResult> {
  const { data, width, height } = await rawRgba(base);
  const placeholder = detectInRaw(data, width, height);
  const dims = await logoDimensions(logo, opts.contentType);

  let target: Box;
  let placement: Placement;
  if (box) {
    target = fitInside(clampBox(box, width, height), dims.width, dims.height);
    placement = opts.placement ?? "model_placeholder";
  } else if (placeholder) {
    target = fitInside(placeholder, dims.width, dims.height);
    placement = "model_placeholder";
  } else {
    target = defaultBox(width, height, dims.width, dims.height);
    placement = "default_corner";
  }

  if (placeholder) {
    // Clear the placeholder (and its anti-aliased fringe) with the ring colour.
    const [fr, fg, fb] = ringColour(data, width, height, placeholder);
    const x0 = Math.max(0, placeholder.x - EDGE_PAD), x1 = Math.min(width - 1, placeholder.x + placeholder.width - 1 + EDGE_PAD);
    const y0 = Math.max(0, placeholder.y - EDGE_PAD), y1 = Math.min(height - 1, placeholder.y + placeholder.height - 1 + EDGE_PAD);
    const strict2 = PLACEHOLDER_TOLERANCE * PLACEHOLDER_TOLERANCE;
    const edge2 = EDGE_TOLERANCE * EDGE_TOLERANCE;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const o = (y * width + x) * 4;
        const d = dist2(data[o], data[o + 1], data[o + 2]);
        if (d <= strict2 || d <= edge2) {
          data[o] = fr; data[o + 1] = fg; data[o + 2] = fb; data[o + 3] = 255;
        }
      }
    }
  }

  const filled = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const logoPng = await rasterizeLogo(logo, opts.contentType, { width: target.width, height: target.height });
  const image = await sharp(filled)
    .composite([{ input: logoPng, left: target.x, top: target.y }])
    .png()
    .toBuffer();

  return { image, layout: target, placement };
}
