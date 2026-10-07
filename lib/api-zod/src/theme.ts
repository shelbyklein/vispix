import { z } from "zod";

// Platform theme (#253): the design tokens a superadmin can edit live. Shared
// by the API (validation, /api/theme.css) and the web app (Design page, live
// preview). warning/success are fill, border and icon colors; their
// -foreground tokens are the readable text colors. DEFAULT_THEME must match
// artifacts/photo-album/src/index.css; a test enforces that, so change both
// together.

/** "H S% L%", the format index.css uses inside hsl(var(--token)). */
export const HSL_PATTERN = /^\d{1,3}(\.\d+)? \d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%$/;

export const COLOR_TOKENS = [
  { key: "background", label: "Page background", group: "Surfaces" },
  { key: "foreground", label: "Body text", group: "Surfaces" },
  { key: "card", label: "Card", group: "Surfaces" },
  { key: "card-foreground", label: "Card text", group: "Surfaces" },
  { key: "card-border", label: "Card border", group: "Surfaces" },
  { key: "popover", label: "Popover / menu", group: "Surfaces" },
  { key: "popover-foreground", label: "Popover text", group: "Surfaces" },
  { key: "popover-border", label: "Popover border", group: "Surfaces" },
  { key: "muted", label: "Muted surface", group: "Surfaces" },
  { key: "muted-foreground", label: "Secondary text", group: "Surfaces" },
  { key: "border", label: "Border", group: "Surfaces" },
  { key: "input", label: "Input border", group: "Surfaces" },
  { key: "primary", label: "Brand / primary", group: "Brand" },
  { key: "primary-foreground", label: "Text on primary", group: "Brand" },
  { key: "secondary", label: "Secondary (navy)", group: "Brand" },
  { key: "secondary-foreground", label: "Text on secondary", group: "Brand" },
  { key: "accent", label: "Hover / highlight", group: "Brand" },
  { key: "accent-foreground", label: "Text on accent", group: "Brand" },
  { key: "ring", label: "Focus ring", group: "Brand" },
  { key: "heading-primary", label: "Page titles (h1)", group: "Headings" },
  { key: "heading-secondary", label: "Other headings", group: "Headings" },
  { key: "destructive", label: "Danger", group: "Status" },
  { key: "destructive-foreground", label: "Text on danger", group: "Status" },
  { key: "warning", label: "Warning fills, borders, icons", group: "Status" },
  { key: "warning-foreground", label: "Warning text", group: "Status" },
  { key: "success", label: "Success fills, borders, icons", group: "Status" },
  { key: "success-foreground", label: "Success text", group: "Status" },
  { key: "sidebar", label: "Sidebar", group: "Sidebar" },
  { key: "sidebar-foreground", label: "Sidebar text", group: "Sidebar" },
  { key: "sidebar-border", label: "Sidebar border", group: "Sidebar" },
  { key: "sidebar-primary", label: "Sidebar active", group: "Sidebar" },
  { key: "sidebar-primary-foreground", label: "Text on sidebar active", group: "Sidebar" },
  { key: "sidebar-accent", label: "Sidebar hover", group: "Sidebar" },
  { key: "sidebar-accent-foreground", label: "Sidebar hover text", group: "Sidebar" },
  { key: "sidebar-ring", label: "Sidebar focus ring", group: "Sidebar" },
  { key: "chart-1", label: "Chart 1", group: "Charts" },
  { key: "chart-2", label: "Chart 2", group: "Charts" },
  { key: "chart-3", label: "Chart 3", group: "Charts" },
  { key: "chart-4", label: "Chart 4", group: "Charts" },
  { key: "chart-5", label: "Chart 5", group: "Charts" },
] as const;

export type ColorTokenKey = (typeof COLOR_TOKENS)[number]["key"];
export type ColorSet = Record<ColorTokenKey, string>;

/** Google Fonts offered on the Design page. Any can be body or heading. */
export const FONT_CHOICES = [
  "Poppins", "Inter", "DM Sans", "Manrope", "Outfit", "Figtree", "Plus Jakarta Sans",
  "Work Sans", "IBM Plex Sans", "Source Sans 3", "Nunito Sans", "Space Grotesk",
  "Playfair Display", "DM Serif Display", "Lora", "Libre Baskerville", "Cormorant Garamond",
  "Fraunces", "Merriweather",
] as const;
export type FontChoice = (typeof FONT_CHOICES)[number];

const SERIF_FONTS: ReadonlySet<string> = new Set([
  "Playfair Display", "DM Serif Display", "Lora", "Libre Baskerville", "Cormorant Garamond", "Fraunces", "Merriweather",
]);

export interface PlatformTheme {
  light: ColorSet;
  dark: ColorSet;
  fonts: { body: FontChoice; heading: FontChoice };
  /** Base corner radius in rem; sm/md/lg/xl derive from it. */
  radius: number;
  /** Multiplies shadow opacity: 0 = flat, 1 = default, 2 = strong. */
  shadowStrength: number;
}

export const DEFAULT_THEME: PlatformTheme = {
  light: {
    background: "222 20% 97%",
    foreground: "222 14% 15%",
    card: "222 20% 99%",
    "card-foreground": "222 14% 15%",
    "card-border": "222 10% 90%",
    popover: "222 20% 99%",
    "popover-foreground": "222 14% 15%",
    "popover-border": "222 10% 90%",
    muted: "222 10% 92%",
    "muted-foreground": "222 10% 45%",
    border: "222 12% 88%",
    input: "222 12% 88%",
    primary: "222 99% 51%",
    "primary-foreground": "0 0% 100%",
    secondary: "224 60% 14%",
    "secondary-foreground": "0 0% 100%",
    accent: "222 30% 92%",
    "accent-foreground": "222 60% 25%",
    ring: "222 99% 51%",
    "heading-primary": "222 92% 45%",
    "heading-secondary": "224 60% 16%",
    destructive: "0 72% 45%",
    "destructive-foreground": "0 0% 100%",
    warning: "38 92% 50%",
    "warning-foreground": "26 90% 37%",
    success: "160 84% 39%",
    "success-foreground": "163 94% 24%",
    sidebar: "222 15% 94%",
    "sidebar-foreground": "222 14% 15%",
    "sidebar-border": "222 12% 88%",
    "sidebar-primary": "222 99% 51%",
    "sidebar-primary-foreground": "0 0% 100%",
    "sidebar-accent": "222 30% 90%",
    "sidebar-accent-foreground": "222 60% 25%",
    "sidebar-ring": "222 99% 51%",
    "chart-1": "222 99% 51%",
    "chart-2": "224 60% 22%",
    "chart-3": "222 90% 68%",
    "chart-4": "222 55% 45%",
    "chart-5": "222 30% 65%",
  },
  dark: {
    background: "224 55% 6%",
    foreground: "222 25% 92%",
    card: "224 45% 9%",
    "card-foreground": "222 25% 92%",
    "card-border": "224 35% 15%",
    popover: "224 45% 9%",
    "popover-foreground": "222 25% 92%",
    "popover-border": "224 35% 15%",
    muted: "224 35% 13%",
    "muted-foreground": "222 15% 62%",
    border: "224 35% 16%",
    input: "224 35% 16%",
    primary: "222 100% 62%",
    "primary-foreground": "0 0% 100%",
    secondary: "224 40% 15%",
    "secondary-foreground": "222 25% 92%",
    accent: "224 45% 16%",
    "accent-foreground": "222 25% 92%",
    ring: "222 100% 62%",
    "heading-primary": "222 100% 66%",
    "heading-secondary": "222 25% 88%",
    destructive: "0 65% 50%",
    "destructive-foreground": "0 0% 100%",
    warning: "43 96% 56%",
    "warning-foreground": "43 96% 56%",
    success: "158 64% 52%",
    "success-foreground": "158 64% 52%",
    sidebar: "224 60% 5%",
    "sidebar-foreground": "222 25% 92%",
    "sidebar-border": "224 35% 14%",
    "sidebar-primary": "222 100% 62%",
    "sidebar-primary-foreground": "0 0% 100%",
    "sidebar-accent": "224 50% 14%",
    "sidebar-accent-foreground": "222 25% 92%",
    "sidebar-ring": "222 100% 62%",
    "chart-1": "222 100% 62%",
    "chart-2": "222 70% 45%",
    "chart-3": "222 90% 75%",
    "chart-4": "224 40% 35%",
    "chart-5": "222 20% 65%",
  },
  fonts: { body: "Poppins", heading: "Playfair Display" },
  radius: 0.5,
  shadowStrength: 1,
};

const hsl = z.string().regex(HSL_PATTERN, 'Expected "H S% L%", e.g. "222 99% 51%"');
const colorSet = z.object(
  Object.fromEntries(COLOR_TOKENS.map((t) => [t.key, hsl])) as Record<ColorTokenKey, typeof hsl>,
);

export const PlatformThemeSchema = z.object({
  light: colorSet,
  dark: colorSet,
  fonts: z.object({ body: z.enum(FONT_CHOICES), heading: z.enum(FONT_CHOICES) }),
  radius: z.number().min(0).max(1.5),
  shadowStrength: z.number().min(0).max(2),
});

// --- API contract (implemented by api-server, consumed by the Design page) ---
//
// GET    /api/theme.css        public, no auth. text/css generated by
//                              themeToCss(saved theme); an empty stylesheet when
//                              none is saved. ETag + Cache-Control: no-cache.
// GET    /api/platform/theme   superadmin. PlatformThemeState.
// PUT    /api/platform/theme   superadmin. Body: PlatformTheme (validated with
//                              PlatformThemeSchema). Returns PlatformThemeState.
// DELETE /api/platform/theme   superadmin. Back to the built-in theme. Returns
//                              PlatformThemeState with theme: null.
export interface PlatformThemeState {
  /** The saved theme, or null when the built-in index.css theme is in use. */
  theme: PlatformTheme | null;
  defaults: PlatformTheme;
  updatedAt: string | null;
}

function fontStack(name: string): string {
  return `"${name}", ${SERIF_FONTS.has(name) ? "Georgia, serif" : "sans-serif"}`;
}

/** Google Fonts stylesheet URL for the theme's fonts (both weights we use). */
export function googleFontsUrl(fonts: PlatformTheme["fonts"]): string {
  const families = [...new Set([fonts.body, fonts.heading])].map(
    (f) => `family=${f.replace(/ /g, "+")}:wght@400;500;600;700`,
  );
  return `https://fonts.googleapis.com/css2?${families.join("&")}&display=swap`;
}

const shadow = (s: number) => {
  const a = (x: number) => +(x * s).toFixed(3);
  return {
    "shadow-sm": `0 1px 2px 0 rgb(0 0 0 / ${a(0.05)})`,
    shadow: `0 1px 3px 0 rgb(0 0 0 / ${a(0.1)}), 0 1px 2px -1px rgb(0 0 0 / ${a(0.1)})`,
    "shadow-md": `0 4px 6px -1px rgb(0 0 0 / ${a(0.1)}), 0 2px 4px -2px rgb(0 0 0 / ${a(0.1)})`,
    "shadow-lg": `0 10px 15px -3px rgb(0 0 0 / ${a(0.1)}), 0 4px 6px -4px rgb(0 0 0 / ${a(0.1)})`,
  };
};

/**
 * CSS that overrides index.css's tokens. Selectors are doubled (`:root:root`,
 * `:root:root.dark`) so this wins regardless of stylesheet order — Vite injects
 * index.css after the <link> in development.
 */
export function themeToCss(theme: PlatformTheme): string {
  const vars = (set: ColorSet) => COLOR_TOKENS.map((t) => `  --${t.key}: ${set[t.key]};`).join("\n");
  const shared = [
    `  --app-font-sans: ${fontStack(theme.fonts.body)};`,
    `  --app-font-heading: ${fontStack(theme.fonts.heading)};`,
    `  --radius: ${theme.radius}rem;`,
    ...Object.entries(shadow(theme.shadowStrength)).map(([k, v]) => `  --${k}: ${v};`),
  ].join("\n");
  return [
    `@import url("${googleFontsUrl(theme.fonts)}");`,
    `:root:root {\n${shared}\n${vars(theme.light)}\n}`,
    `:root:root.dark {\n${vars(theme.dark)}\n}`,
    "",
  ].join("\n");
}
