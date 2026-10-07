import { z } from "zod";
import type { PlatformTheme } from "./theme";

// Palette tool (#257) on the Design page: build a palette from a color wheel
// with harmony rules, a base color or an image, assign swatches to roles, and
// turn the roles into a full theme. Shared by the web app (the tool) and the
// API (saved palettes). Colors are "#RRGGBB" hex strings throughout.
//
// The color engine below is implemented in this file.
// Signatures are the contract: do not change them without updating every caller.

export const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Swatches a generated palette has (index 0 is the base color). */
export const PALETTE_SIZE = 5;

export const HARMONY_RULES = [
  { rule: "analogous", label: "Analogous" },
  { rule: "monochromatic", label: "Monochromatic" },
  { rule: "complementary", label: "Complementary" },
  { rule: "split-complementary", label: "Split complementary" },
  { rule: "triadic", label: "Triadic" },
  { rule: "square", label: "Square" },
  { rule: "compound", label: "Compound" },
  { rule: "shades", label: "Shades" },
] as const;
export type HarmonyRule = (typeof HARMONY_RULES)[number]["rule"];

/** A point on the color wheel: hue in degrees (0–360), saturation 0–1 (center to rim). */
export interface WheelPoint {
  hue: number;
  saturation: number;
}

export const PALETTE_ROLES = [
  { role: "background", label: "Page background", description: "Behind every page; cards are derived from it." },
  { role: "secondary-background", label: "Secondary background", description: "Sidebar, secondary buttons and the second chart color." },
  { role: "headings", label: "Headings", description: "Page titles and section headings." },
  { role: "button", label: "Button", description: "Main buttons; their text color is picked for contrast." },
  { role: "brand", label: "Brand", description: "Links, focus rings, active items, progress bars." },
] as const;
export type PaletteRole = (typeof PALETTE_ROLES)[number]["role"];
export type RoleAssignment = Partial<Record<PaletteRole, string>>;

export const COLOR_VISIONS = [
  { vision: "normal", label: "Normal vision" },
  { vision: "protanopia", label: "Protanopia (red-blind)" },
  { vision: "deuteranopia", label: "Deuteranopia (green-blind)" },
  { vision: "tritanopia", label: "Tritanopia (blue-blind)" },
  { vision: "achromatopsia", label: "Achromatopsia (no color)" },
] as const;
export type ColorVision = (typeof COLOR_VISIONS)[number]["vision"];

// --- Color math -----------------------------------------------------------
//
// Wheel convention (for the UI): the HSL color wheel, as in Adobe's. Hue is the
// angle in degrees; the hue ORDER is fixed: red 0°, yellow 60°, green 120°,
// cyan 180°, blue 240°, magenta 300° (the UI picks where 0° sits on screen and
// which way it winds). Saturation is HSL saturation: 0 at the center (gray) to
// 1 at the rim (fully saturated). Lightness is not on the wheel; each swatch
// carries its own.

type RGB = [number, number, number];
type HSL = [number, number, number]; // h 0-360, s 0-1, l 0-1

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const mod360 = (h: number) => ((h % 360) + 360) % 360;

/** "#rrggbb" (or "rrggbb") to RGB 0-255. Throws on anything else. */
export function parseHex(hex: string): RGB {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new Error(`Invalid hex color: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  const h = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

function rgbToHsl([r, g, b]: RGB): HSL {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rr) h = (gg - bb) / d + (gg < bb ? 6 : 0);
  else if (max === gg) h = (bb - rr) / d + 2;
  else h = (rr - gg) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]: HSL): RGB {
  const hh = mod360(h) / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255];
}

export const hexToHsl = (hex: string): HSL => rgbToHsl(parseHex(hex));
export const hslToHex = (hsl: HSL): string => rgbToHex(hslToRgb(hsl));

const trimNum = (n: number) => String(Math.round(n * 10) / 10 + 0);

/** "#RRGGBB" to the theme's "H S% L%" format (1 decimal max). */
export function hexToHslString(hex: string): string {
  const [h, s, l] = hexToHsl(hex);
  const hr = Math.round(h * 10) / 10 >= 360 ? 0 : h;
  return `${trimNum(hr)} ${trimNum(s * 100)}% ${trimNum(l * 100)}%`;
}

/** The theme's "H S% L%" format to "#RRGGBB". */
export function hslStringToHex(value: string): string {
  const m = /^(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%$/.exec(value.trim());
  if (!m) throw new Error(`Invalid HSL string: ${value}`);
  return hslToHex([Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100]);
}

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) => {
  const c = clamp(v, 0, 1);
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
};

type Lab = [number, number, number];

function rgbToOklab(rgb: RGB): Lab {
  const r = toLinear(rgb[0]), g = toLinear(rgb[1]), b = toLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Linear-light RGB (unclamped, may be out of gamut) from OKLab. */
function oklabToLinear([L, a, b]: Lab): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

interface Lch { l: number; c: number; h: number }

function hexToLch(hex: string): Lch {
  const [L, a, b] = rgbToOklab(parseHex(hex));
  return { l: L, c: Math.hypot(a, b), h: mod360((Math.atan2(b, a) * 180) / Math.PI) };
}

const inGamut = (rgb: RGB) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);

/** OKLCH to hex; chroma is reduced until the color fits sRGB. */
function lchToHex(l: number, c: number, h: number): string {
  const L = clamp(l, 0, 1);
  const rad = (h * Math.PI) / 180;
  const at = (chroma: number): RGB => oklabToLinear([L, chroma * Math.cos(rad), chroma * Math.sin(rad)]);
  let chroma = Math.max(0, c);
  if (!inGamut(at(chroma))) {
    let lo = 0, hi = chroma;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(at(mid))) lo = mid; else hi = mid;
    }
    chroma = lo;
  }
  const lin = at(chroma);
  return rgbToHex([fromLinear(lin[0]), fromLinear(lin[1]), fromLinear(lin[2])]);
}

function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2.x contrast ratio between two colors (1–21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// --- Wheel & harmony ------------------------------------------------------

/** Where a color sits on the wheel (lightness is dropped). */
export function hexToWheel(hex: string): WheelPoint {
  const [h, s] = hexToHsl(hex);
  return { hue: h, saturation: s };
}

/** The color at a wheel point, at the given lightness (0–1, default 0.6). */
export function wheelToHex(point: WheelPoint, lightness = 0.6): string {
  return hslToHex([mod360(point.hue), clamp(point.saturation, 0, 1), clamp(lightness, 0, 1)]);
}

interface Step { dh: number; ds: number; dl: number }
const st = (dh: number, ds = 0, dl = 0): Step => ({ dh, ds, dl });
const TINT = (dh = 0) => st(dh, -0.1, 0.22);
const SHADE = (dh = 0) => st(dh, 0.05, -0.2);

/** Swatches 1..4 of each rule, relative to the base (swatch 0). "shades" is computed separately. */
const HARMONY_STEPS: Record<Exclude<HarmonyRule, "shades">, Step[]> = {
  analogous: [st(30, 0, 0.06), st(60, 0, -0.05), st(-30, 0, 0.1), st(-60, 0, -0.1)],
  monochromatic: [st(0, -0.15, 0.3), st(0, -0.05, 0.15), st(0, 0.05, -0.15), st(0, 0.1, -0.28)],
  complementary: [st(180), TINT(0), st(180, 0, -0.15), SHADE(0)],
  "split-complementary": [st(150), st(210), TINT(0), SHADE(0)],
  triadic: [st(120), st(240), TINT(0), st(120, -0.05, 0.2)],
  square: [st(90), st(180), st(270), SHADE(0)],
  compound: [st(30, 0, 0.05), st(180), st(150, 0, -0.08), st(210, 0, 0.08)],
};

/**
 * Hue offset (degrees from the base swatch) of each of the PALETTE_SIZE
 * swatches, per rule. Index 0 is the base.
 */
export const HARMONY_HUE_OFFSETS: Record<HarmonyRule, number[]> = {
  analogous: [0, ...HARMONY_STEPS.analogous.map((s) => s.dh)],
  monochromatic: [0, 0, 0, 0, 0],
  complementary: [0, ...HARMONY_STEPS.complementary.map((s) => s.dh)],
  "split-complementary": [0, ...HARMONY_STEPS["split-complementary"].map((s) => s.dh)],
  triadic: [0, ...HARMONY_STEPS.triadic.map((s) => s.dh)],
  square: [0, ...HARMONY_STEPS.square.map((s) => s.dh)],
  compound: [0, ...HARMONY_STEPS.compound.map((s) => s.dh)],
  shades: [0, 0, 0, 0, 0],
};

const isLinkedHueRule = (rule: HarmonyRule) => rule !== "monochromatic" && rule !== "shades";

function stepLightness(l: number, dl: number): number {
  const v = l + dl;
  if (v > 0.94 || v < 0.08) return clamp(l - dl, 0.08, 0.94);
  return v;
}

/** PALETTE_SIZE colors for the rule; index 0 is `baseHex` (normalized to uppercase). */
export function harmony(baseHex: string, rule: HarmonyRule): string[] {
  const base = rgbToHex(parseHex(baseHex));
  const [h, s, l] = hexToHsl(base);
  if (rule === "shades") {
    const ladder = [0.9, 0.725, 0.55, 0.375, 0.2];
    let nearest = 0;
    ladder.forEach((v, i) => { if (Math.abs(v - l) < Math.abs(ladder[nearest]! - l)) nearest = i; });
    const others = ladder.filter((_, i) => i !== nearest);
    return [base, ...others.map((v) => hslToHex([h, s, v]))];
  }
  const steps = HARMONY_STEPS[rule];
  return [base, ...steps.map((p) => hslToHex([h + p.dh, clamp(s + p.ds, 0, 1), stepLightness(l, p.dl)]))];
}

/**
 * Re-generate the rule's other swatches after the user drags swatch `index`
 * on the wheel, keeping the harmony's angles and every swatch's lightness.
 * Linked rules: the others rotate with the dragged swatch and their saturation
 * shifts by the same amount; monochromatic/shades: all share the dragged
 * hue and saturation.
 */
export function moveOnWheel(palette: string[], rule: HarmonyRule, index: number, to: WheelPoint): string[] {
  const offsets = HARMONY_HUE_OFFSETS[rule];
  const hsls = palette.map(hexToHsl);
  const dragged = hsls[index];
  if (!dragged) return palette.map((c) => rgbToHex(parseHex(c)));
  const sat = clamp(to.saturation, 0, 1);
  const baseHue = to.hue - (offsets[index] ?? 0);
  const dSat = sat - dragged[1];
  return hsls.map(([, s, l], i) => {
    if (i === index || !isLinkedHueRule(rule)) return hslToHex([mod360(to.hue), sat, l]);
    return hslToHex([mod360(baseHue + (offsets[i] ?? 0)), clamp(s + dSat, 0, 1), l]);
  });
}

// --- Image extraction -----------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_SAMPLES = 10000;
const MERGE_DISTANCE = 0.06; // OKLab distance under which two colors count as one

interface Point { rgb: RGB; lab: Lab; w: number }
const labDist2 = (a: Lab, b: Lab) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/**
 * Dominant colors of an image: RGBA pixels as from canvas getImageData. Skips
 * transparent pixels; returns up to `count` distinct colors, most common first.
 */
export function extractPalette(rgba: Uint8ClampedArray, count = PALETTE_SIZE): string[] {
  const want = Math.max(1, Math.floor(count));
  const total = Math.floor(rgba.length / 4);
  const stride = Math.max(1, Math.floor(total / MAX_SAMPLES));
  // Histogram on 5 bits per channel; each bin is represented by its mean color.
  const bins = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (let p = 0; p < total; p += stride) {
    const i = p * 4;
    if (rgba[i + 3]! < 128) continue;
    const r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const bin = bins.get(key);
    if (bin) { bin.r += r; bin.g += g; bin.b += b; bin.n++; } else bins.set(key, { r, g, b, n: 1 });
  }
  if (bins.size === 0) return [];
  const points: Point[] = [...bins.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => {
      const rgb: RGB = [v.r / v.n, v.g / v.n, v.b / v.n];
      return { rgb, lab: rgbToOklab(rgb), w: v.n };
    });

  const k = Math.min(want, points.length);
  const rand = mulberry32(0x9e3779b9);
  // Weighted k-means++ init.
  const centers: Lab[] = [];
  const first = points.reduce((best, p) => (p.w > best.w ? p : best), points[0]!);
  centers.push(first.lab);
  const minD = points.map((p) => labDist2(p.lab, first.lab));
  while (centers.length < k) {
    const sum = points.reduce((acc, p, i) => acc + p.w * minD[i]!, 0);
    if (sum <= 0) break;
    let target = rand() * sum;
    let pick = points.length - 1;
    for (let i = 0; i < points.length; i++) {
      target -= points[i]!.w * minD[i]!;
      if (target <= 0) { pick = i; break; }
    }
    centers.push(points[pick]!.lab);
    for (let i = 0; i < points.length; i++) minD[i] = Math.min(minD[i]!, labDist2(points[i]!.lab, points[pick]!.lab));
  }

  const assign = new Array<number>(points.length).fill(0);
  for (let iter = 0; iter < 24; iter++) {
    let moved = false;
    points.forEach((p, i) => {
      let best = 0, bestD = Infinity;
      centers.forEach((c, ci) => {
        const d = labDist2(p.lab, c);
        if (d < bestD) { bestD = d; best = ci; }
      });
      if (assign[i] !== best) { assign[i] = best; moved = true; }
    });
    const sums = centers.map(() => ({ l: 0, a: 0, b: 0, w: 0 }));
    points.forEach((p, i) => {
      const s = sums[assign[i]!]!;
      s.l += p.lab[0] * p.w; s.a += p.lab[1] * p.w; s.b += p.lab[2] * p.w; s.w += p.w;
    });
    sums.forEach((s, ci) => { if (s.w > 0) centers[ci] = [s.l / s.w, s.a / s.w, s.b / s.w]; });
    if (!moved && iter > 0) break;
  }

  // Cluster colors: weighted mean sRGB of members (exact for flat regions).
  let clusters = centers
    .map((_, ci) => {
      let r = 0, g = 0, b = 0, w = 0;
      points.forEach((p, i) => {
        if (assign[i] !== ci) return;
        r += p.rgb[0] * p.w; g += p.rgb[1] * p.w; b += p.rgb[2] * p.w; w += p.w;
      });
      return w > 0 ? { rgb: [r / w, g / w, b / w] as RGB, w } : null;
    })
    .filter((c): c is { rgb: RGB; w: number } => c !== null);

  // Merge near-duplicates.
  for (let merged = true; merged && clusters.length > 1;) {
    merged = false;
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i]!, b = clusters[j]!;
        if (Math.sqrt(labDist2(rgbToOklab(a.rgb), rgbToOklab(b.rgb))) < MERGE_DISTANCE) {
          const w = a.w + b.w;
          const rgb: RGB = [
            (a.rgb[0] * a.w + b.rgb[0] * b.w) / w,
            (a.rgb[1] * a.w + b.rgb[1] * b.w) / w,
            (a.rgb[2] * a.w + b.rgb[2] * b.w) / w,
          ];
          clusters = clusters.filter((_, x) => x !== i && x !== j);
          clusters.push({ rgb, w });
          merged = true;
          break outer;
        }
      }
    }
  }

  return clusters.sort((a, b) => b.w - a.w).map((c) => rgbToHex(c.rgb));
}

// --- Color-vision simulation ----------------------------------------------

type Matrix = [RGB, RGB, RGB];
// Machado, Oliveira & Fernandes (2009), severity 1.0, applied to linear RGB.
const VISION_MATRICES: Record<"protanopia" | "deuteranopia" | "tritanopia", Matrix> = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};

/** How `hex` looks to someone with the given color-vision deficiency. */
export function simulateColorVision(hex: string, vision: ColorVision): string {
  const rgb = parseHex(hex);
  if (vision === "normal") return rgbToHex(rgb);
  if (vision === "achromatopsia") {
    const y = fromLinear(luminance(hex));
    return rgbToHex([y, y, y]);
  }
  const m = VISION_MATRICES[vision];
  const lin: RGB = [toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])];
  const out = m.map((row) => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]);
  return rgbToHex([fromLinear(out[0]!), fromLinear(out[1]!), fromLinear(out[2]!)]);
}

// --- Theme derivation -----------------------------------------------------

/** What the stored "H S% L%" value of a color looks like after the round trip. */
const snap = (hex: string) => hslStringToHex(hexToHslString(hex));

const BLACK = "#000000";
const WHITE = "#FFFFFF";

function passes(color: string, bgs: string[], min: number) {
  return bgs.every((b) => contrastRatio(color, b) >= min);
}

function bestBlackOrWhite(bgs: string[]): string {
  const worst = (c: string) => Math.min(...bgs.map((b) => contrastRatio(c, b)));
  return worst(BLACK) >= worst(WHITE) ? BLACK : WHITE;
}

/**
 * `color` unchanged if it reaches `min` on every background, else moved in
 * OKLCH lightness only (hue and chroma kept, gamut-clamped) as little as
 * needed. Prefers darker on light backgrounds and lighter on dark ones, tries
 * the other direction if that can't reach it, and falls back to black/white.
 */
function ensure(color: string, bgs: string[], min: number, dir?: "darker" | "lighter"): string {
  const start = snap(color);
  if (passes(start, bgs, min)) return start;
  const lch = hexToLch(start);
  const avg = bgs.reduce((a, b) => a + luminance(b), 0) / bgs.length;
  const first = dir ?? (avg > 0.18 ? "darker" : "lighter");
  const order: ("darker" | "lighter")[] = first === "darker" ? ["darker", "lighter"] : ["lighter", "darker"];
  for (const d of order) {
    const sign = d === "darker" ? -1 : 1;
    for (let i = 1; i <= 250; i++) {
      const l = lch.l + sign * i * 0.004;
      if (l < 0 || l > 1) break;
      const cand = snap(lchToHex(l, lch.c, lch.h));
      if (passes(cand, bgs, min)) return cand;
    }
  }
  return bestBlackOrWhite(bgs);
}

/** A text color for `bg`: bg's hue, near-black or near-white by its luminance, >= 4.5. */
function readable(bg: string): string {
  const lch = hexToLch(bg);
  const dark = luminance(bg) > 0.18;
  return ensure(lchToHex(dark ? 0.22 : 0.96, Math.min(lch.c, 0.04), lch.h), [bg], 4.5, dark ? "darker" : "lighter");
}

/** Text on a brand fill: white or tinted near-black, first one (in `preferWhite` order) reaching 4.5. */
function onFill(fill: string, preferWhite: boolean): string {
  const lch = hexToLch(fill);
  const dark = snap(lchToHex(0.18, Math.min(lch.c, 0.03), lch.h));
  const white = snap(WHITE);
  const order = preferWhite ? [white, dark] : [dark, white];
  for (const c of order) if (contrastRatio(c, fill) >= 4.5) return c;
  return bestBlackOrWhite([fill]);
}

type Tokens = PlatformTheme["light"];
type TokenKey = keyof Tokens;

function deriveMode(out: Tokens, mode: "light" | "dark", roles: RoleAssignment) {
  const light = mode === "light";
  const get = (k: TokenKey) => hslStringToHex(out[k]);
  const set = (k: TokenKey, hex: string) => { out[k] = hexToHslString(hex); };
  const lc = (l: number, c: number, h: number) => snap(lchToHex(l, c, h));

  // Background group
  if (roles.background) {
    const B = rgbToHex(parseHex(roles.background));
    const bl = hexToLch(B);
    const hue = bl.h;
    const src = roles.headings ? hexToLch(roles.headings) : bl;
    const textHue = src.h;
    let bg: string, card: string, border: string, muted: string, accent: string;
    if (light) {
      // Tints move to the side of the text-color flip point (luminance ~0.18)
      // the background is already on, so one text color can serve both.
      const lumB = luminance(B);
      const sgn = lumB > 0.18 && lumB < 0.25 ? 1 : lumB <= 0.18 && lumB > 0.12 ? -1 : bl.l > 0.5 ? -1 : 1;
      const cn = Math.min(bl.c * 0.7, 0.015);
      bg = snap(B);
      // Card: very slightly lighter, but never across the text flip point.
      card = snap(B);
      for (let step = Math.min((1 - bl.l) * 0.65, 0.04); step > 0.002; step /= 2) {
        const cand = lc(bl.l + step, Math.min(bl.c * 0.5, 0.012), hue);
        if (luminance(cand) > 0.179 === luminance(B) > 0.179) { card = cand; break; }
      }
      border = lc(bl.l + sgn * 0.09, cn, hue);
      muted = lc(bl.l + sgn * 0.035, cn, hue);
      accent = lc(bl.l + sgn * 0.05, cn, hue);
    } else {
      const c = Math.min(bl.c * 0.3, 0.02);
      bg = lc(0.16, c, hue);
      card = lc(0.2, c, hue);
      border = lc(0.3, c, hue);
      muted = lc(0.25, c, hue);
      accent = lc(0.27, c, hue);
    }
    set("background", bg);
    set("card", card);
    set("popover", card);
    set("card-border", border);
    set("popover-border", border);
    set("border", border);
    set("input", border);
    set("muted", muted);
    set("accent", accent);
    const dir = light ? "darker" : "lighter";
    const fgStart = light ? lc(0.25, Math.min(src.c, 0.03), textHue) : lc(0.93, Math.min(src.c, 0.02), textHue);
    const fg = ensure(fgStart, [bg, card, muted], 7, dir);
    set("foreground", fg);
    set("card-foreground", fg);
    set("popover-foreground", fg);
    const mutedStart = light ? lc(0.45, Math.min(src.c, 0.03), textHue) : lc(0.72, Math.min(src.c, 0.02), textHue);
    set("muted-foreground", ensure(mutedStart, [bg, card, muted, get("sidebar")], 4.5, dir));
    set("accent-foreground", ensure(fg, [accent], 4.5, dir));
  }

  // Secondary background group
  if (roles["secondary-background"]) {
    const S = rgbToHex(parseHex(roles["secondary-background"]));
    const sl = hexToLch(S);
    if (light) {
      const sidebar = snap(S);
      set("secondary", sidebar);
      set("sidebar", sidebar);
      set("chart-2", sidebar);
      set("sidebar-border", lc(sl.l - 0.08, sl.c, sl.h));
      // Hover tint moves away from the text color so text keeps its contrast.
      const sa = luminance(sidebar) > 0.18 ? lc(sl.l + (1 - sl.l) * 0.5, sl.c * 0.8, sl.h) : lc(sl.l * 0.8, sl.c, sl.h);
      set("sidebar-accent", sa);
      set("secondary-foreground", readable(sidebar));
      const sf = ensure(readable(sidebar), [sidebar, sa], 4.5);
      set("sidebar-foreground", sf);
      set("sidebar-accent-foreground", sf);
    } else {
      const sec = lc(0.32, Math.min(sl.c, 0.07), sl.h);
      const sidebar = lc(0.12, Math.min(sl.c, 0.025), sl.h);
      const sa = lc(0.27, Math.min(sl.c, 0.05), sl.h);
      set("secondary", sec);
      set("secondary-foreground", readable(sec));
      set("sidebar", sidebar);
      set("sidebar-border", lc(0.2, Math.min(sl.c, 0.03), sl.h));
      set("sidebar-accent", sa);
      const sf = ensure(lc(0.92, Math.min(sl.c, 0.02), sl.h), [sidebar, sa], 4.5, "lighter");
      set("sidebar-foreground", sf);
      set("sidebar-accent-foreground", sf);
      set("chart-2", lc(Math.max(sl.l, 0.7), sl.c, sl.h));
    }
  }

  // Headings
  if (roles.headings) {
    const hl = hexToLch(roles.headings);
    const bgs = [get("background"), get("card")];
    const start = light ? snap(roles.headings) : lc(Math.max(hl.l, 0.78), hl.c, hl.h);
    const h = ensure(start, bgs, 3, light ? "darker" : "lighter");
    set("heading-primary", h);
    set("heading-secondary", h);
  }

  // Button
  if (roles.button) {
    const K = rgbToHex(parseHex(roles.button));
    const kl = hexToLch(K);
    const fill = light || kl.l >= 0.6 ? snap(K) : lc(0.65, kl.c, kl.h);
    set("button", fill);
    set("button-foreground", readable(fill));
  }

  // Brand
  if (roles.brand) {
    const P = rgbToHex(parseHex(roles.brand));
    const pl = hexToLch(P);
    const bgs = [get("background"), get("card")];
    const start = light ? snap(P) : lc(Math.max(pl.l, 0.72), pl.c, pl.h);
    const p = ensure(start, bgs, 4.5, light ? "darker" : "lighter");
    for (const k of ["primary", "ring", "sidebar-primary", "sidebar-ring", "chart-1"] as const) set(k, p);
    const pf = onFill(p, light);
    set("primary-foreground", pf);
    set("sidebar-primary-foreground", pf);
  }

  // Final pass: every text pair reaches its minimum; only failing tokens move.
  const dir = light ? "darker" : "lighter";
  const fix = (k: TokenKey, against: TokenKey[], min: number) => {
    const bgs = against.map(get);
    const cur = get(k);
    if (passes(cur, bgs, min)) return;
    set(k, ensure(cur, bgs, min, dir));
  };
  fix("foreground", ["background"], 4.5);
  fix("card-foreground", ["card"], 4.5);
  fix("popover-foreground", ["popover"], 4.5);
  fix("muted-foreground", ["background", "card", "muted", "sidebar"], 4.5);
  fix("primary", ["background", "card"], 4.5);
  fix("primary-foreground", ["primary"], 4.5);
  fix("button-foreground", ["button"], 4.5);
  fix("secondary-foreground", ["secondary"], 4.5);
  fix("accent-foreground", ["accent"], 4.5);
  fix("sidebar-foreground", ["sidebar", "sidebar-accent"], 4.5);
  fix("sidebar-accent-foreground", ["sidebar-accent"], 4.5);
  fix("sidebar-primary-foreground", ["sidebar-primary"], 4.5);
  fix("heading-primary", ["background"], 3);
  fix("heading-secondary", ["background"], 3);
  fix("destructive-foreground", ["destructive"], 4.5);
  fix("warning-foreground", ["background"], 4.5);
  fix("success-foreground", ["background"], 4.5);
}

/**
 * A complete theme from role colors. Assigned roles set their tokens in light
 * mode exactly (brand and headings may be darkened only as far as needed to
 * reach 4.5:1 / 3:1 on the background); every text/foreground token is chosen
 * for >= 4.5:1; dark mode is derived from the same colors. Roles not assigned
 * keep `base`'s values. Fonts, radius and the other non-color fields are
 * copied from `base`.
 */
export function deriveTheme(base: PlatformTheme, roles: RoleAssignment): PlatformTheme {
  const theme: PlatformTheme = {
    ...base,
    light: { ...base.light },
    dark: { ...base.dark },
    fonts: { ...base.fonts },
  };
  if (!PALETTE_ROLES.some((r) => roles[r.role])) return theme;
  deriveMode(theme.light, "light", roles);
  deriveMode(theme.dark, "dark", roles);
  return theme;
}

// --- Saved palettes (API contract; implemented by api-server) ---
//
// All superadmin only, platform-wide (not per organization):
// GET    /api/platform/palettes        → SavedPalette[] (newest first)
// POST   /api/platform/palettes        body SavedPaletteInput → SavedPalette (201)
// PUT    /api/platform/palettes/:id    body SavedPaletteInput → SavedPalette
// DELETE /api/platform/palettes/:id    → 204

const hex = z.string().regex(HEX_PATTERN, 'Expected "#RRGGBB"');
const roleEnum = z.enum(PALETTE_ROLES.map((r) => r.role) as [PaletteRole, ...PaletteRole[]]);
const harmonyEnum = z.enum(HARMONY_RULES.map((h) => h.rule) as [HarmonyRule, ...HarmonyRule[]]);

export const SavedPaletteInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  swatches: z.array(hex).min(1).max(10),
  roles: z.record(roleEnum, hex).default({}),
  harmony: harmonyEnum.nullable().default(null),
});
export type SavedPaletteInput = z.infer<typeof SavedPaletteInputSchema>;

export interface SavedPalette {
  id: number;
  name: string;
  swatches: string[];
  roles: RoleAssignment;
  harmony: HarmonyRule | null;
  createdAt: string;
  updatedAt: string;
}
