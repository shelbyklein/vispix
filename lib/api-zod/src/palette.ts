import { z } from "zod";
import type { PlatformTheme } from "./theme";

// Palette tool (#257) on the Design page: build a palette from a color wheel
// with harmony rules, a base color or an image, assign swatches to roles, and
// turn the roles into a full theme. Shared by the web app (the tool) and the
// API (saved palettes). Colors are "#RRGGBB" hex strings throughout.
//
// The functions below are implemented in this file by the palette-engine lane;
// until then they throw. Signatures are the contract — don't change them
// without updating every caller.

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

const notYet = (name: string): never => {
  throw new Error(`palette.${name} is not implemented yet`);
};

/** PALETTE_SIZE colors for the rule; index 0 is `baseHex` (normalized to uppercase). */
export function harmony(baseHex: string, rule: HarmonyRule): string[] {
  return notYet(`harmony(${baseHex}, ${rule})`);
}

/** Where a color sits on the wheel (lightness is dropped). */
export function hexToWheel(hex: string): WheelPoint {
  return notYet(`hexToWheel(${hex})`);
}

/** The color at a wheel point, at the given lightness (0–1, default 0.6). */
export function wheelToHex(point: WheelPoint, lightness?: number): string {
  return notYet(`wheelToHex(${point.hue}, ${lightness})`);
}

/**
 * Re-generate the rule's other swatches after the user drags swatch `index`
 * on the wheel, keeping the harmony's angles and every swatch's lightness.
 */
export function moveOnWheel(palette: string[], rule: HarmonyRule, index: number, to: WheelPoint): string[] {
  return notYet(`moveOnWheel(${palette.length}, ${rule}, ${index}, ${to.hue})`);
}

/**
 * Dominant colors of an image: RGBA pixels as from canvas getImageData. Skips
 * transparent pixels; returns up to `count` distinct colors, most common first.
 */
export function extractPalette(rgba: Uint8ClampedArray, count?: number): string[] {
  return notYet(`extractPalette(${rgba.length}, ${count})`);
}

/** How `hex` looks to someone with the given color-vision deficiency. */
export function simulateColorVision(hex: string, vision: ColorVision): string {
  return notYet(`simulateColorVision(${hex}, ${vision})`);
}

/** WCAG 2.x contrast ratio between two colors (1–21). */
export function contrastRatio(a: string, b: string): number {
  return notYet(`contrastRatio(${a}, ${b})`);
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
  return notYet(`deriveTheme(${Object.keys(roles).join(",")})`);
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
