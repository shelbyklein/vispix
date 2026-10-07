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
  { key: "button", label: "Button background", group: "Brand" },
  { key: "button-foreground", label: "Button text", group: "Brand" },
  { key: "secondary", label: "Secondary", group: "Brand" },
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

/**
 * Fonts offered on the Design page. Any can be body or heading. All are Google
 * Fonts except ADOBE_FONTS, which load from an Adobe Fonts web project.
 */
export const FONT_CHOICES = [
  "Sofia Pro", "Sofia Sans", "Karla", "Poppins", "Inter", "DM Sans", "Manrope", "Outfit", "Figtree", "Plus Jakarta Sans",
  "Work Sans", "IBM Plex Sans", "Source Sans 3", "Nunito Sans", "Space Grotesk",
  "Playfair Display", "DM Serif Display", "Lora", "Libre Baskerville", "Cormorant Garamond",
  "Fraunces", "Merriweather",
] as const;
export type FontChoice = (typeof FONT_CHOICES)[number];

/** Fonts served by Adobe Fonts (Typekit), not Google. */
export const ADOBE_FONTS: ReadonlySet<string> = new Set(["Sofia Pro"]);

/** Google font to show until the Adobe Fonts project is available. */
const ADOBE_FALLBACKS: Readonly<Record<string, string>> = { "Sofia Pro": "Sofia Sans" };
/** The family name each Adobe font registers under in its kit CSS. */
export const ADOBE_FAMILY_NAMES: Readonly<Record<string, string>> = { "Sofia Pro": "sofia-pro" };

/** The ID in https://use.typekit.net/<id>.css: 7-12 lowercase alphanumerics. */
export const ADOBE_PROJECT_PATTERN = /^[a-z0-9]{7,12}$/;

const SERIF_FONTS: ReadonlySet<string> = new Set([
  "Playfair Display", "DM Serif Display", "Lora", "Libre Baskerville", "Cormorant Garamond", "Fraunces", "Merriweather",
]);

export interface PlatformTheme {
  light: ColorSet;
  dark: ColorSet;
  fonts: { body: FontChoice; heading: FontChoice };
  /** Weight (100-900, step 100) of h1-h6. */
  headingWeight: number;
  /** Weight (100-900, step 100) of button labels. */
  buttonWeight: number;
  /** Adobe Fonts web project ID, or null. Required for Adobe-only fonts to load. */
  adobeFontsProject: string | null;
  /** Base corner radius in rem; sm/md/lg/xl derive from it. */
  radius: number;
  /** Multiplies shadow opacity: 0 = flat, 1 = default, 2 = strong. */
  shadowStrength: number;
}

export const DEFAULT_THEME: PlatformTheme = {
  light: {
    background: "0 0% 99%",
    foreground: "200 12% 18%",
    card: "0 0% 100%",
    "card-foreground": "200 12% 18%",
    "card-border": "200 8% 88%",
    popover: "0 0% 100%",
    "popover-foreground": "200 12% 18%",
    "popover-border": "200 8% 88%",
    muted: "200 8% 95%",
    "muted-foreground": "200 8% 30%",
    border: "200 8% 88%",
    input: "200 8% 88%",
    primary: "211 32% 36%",
    "primary-foreground": "0 0% 100%",
    button: "211.2 32.5% 84.9%",
    "button-foreground": "205 25% 18%",
    secondary: "33.9 67.6% 73.3%",
    "secondary-foreground": "205 25% 16%",
    accent: "200 10% 93%",
    "accent-foreground": "205 25% 18%",
    ring: "211 32% 36%",
    "heading-primary": "200 7.3% 40.2%",
    "heading-secondary": "200 7.3% 40.2%",
    destructive: "4 68% 44%",
    "destructive-foreground": "0 0% 100%",
    warning: "38 92% 50%",
    "warning-foreground": "26 90% 37%",
    success: "160 84% 39%",
    "success-foreground": "163 94% 24%",
    sidebar: "33.9 67.6% 73.3%",
    "sidebar-foreground": "205 25% 14%",
    "sidebar-border": "34 45% 64%",
    "sidebar-primary": "211 32% 36%",
    "sidebar-primary-foreground": "0 0% 100%",
    "sidebar-accent": "40 80% 88%",
    "sidebar-accent-foreground": "205 25% 14%",
    "sidebar-ring": "211 32% 36%",
    "chart-1": "211 32% 36%",
    "chart-2": "33.9 67.6% 73.3%",
    "chart-3": "200 7.3% 40.2%",
    "chart-4": "211 37% 70%",
    "chart-5": "20 60% 62%",
  },
  dark: {
    background: "200 6% 5%",
    foreground: "0 0% 93%",
    card: "200 5% 8%",
    "card-foreground": "0 0% 93%",
    "card-border": "200 5% 17%",
    popover: "200 5% 8%",
    "popover-foreground": "0 0% 93%",
    "popover-border": "200 5% 17%",
    muted: "200 5% 12%",
    "muted-foreground": "200 5% 64%",
    border: "200 5% 17%",
    input: "200 5% 17%",
    primary: "211 50% 74%",
    "primary-foreground": "205 25% 12%",
    button: "211.2 32.5% 84.9%",
    "button-foreground": "205 25% 16%",
    secondary: "34 38% 36%",
    "secondary-foreground": "0 0% 96%",
    accent: "200 5% 14%",
    "accent-foreground": "0 0% 93%",
    ring: "211 50% 74%",
    "heading-primary": "200 14% 74%",
    "heading-secondary": "200 14% 74%",
    destructive: "4 70% 48%",
    "destructive-foreground": "0 0% 100%",
    warning: "43 96% 56%",
    "warning-foreground": "43 96% 56%",
    success: "158 64% 52%",
    "success-foreground": "158 64% 52%",
    sidebar: "200 6% 3%",
    "sidebar-foreground": "0 0% 90%",
    "sidebar-border": "200 5% 11%",
    "sidebar-primary": "211 50% 74%",
    "sidebar-primary-foreground": "205 25% 12%",
    "sidebar-accent": "34 30% 18%",
    "sidebar-accent-foreground": "0 0% 93%",
    "sidebar-ring": "211 50% 74%",
    "chart-1": "211 50% 74%",
    "chart-2": "34 60% 62%",
    "chart-3": "200 14% 60%",
    "chart-4": "211 40% 55%",
    "chart-5": "20 60% 60%",
  },
  fonts: { body: "Karla", heading: "Sofia Pro" },
  headingWeight: 600,
  buttonWeight: 400,
  adobeFontsProject: "ixt2dst",
  radius: 0.5,
  shadowStrength: 1,
};

const hsl = z.string().regex(HSL_PATTERN, 'Expected "H S% L%", e.g. "222 99% 51%"');
const colorSet = z.object(
  Object.fromEntries(COLOR_TOKENS.map((t) => [t.key, hsl])) as Record<ColorTokenKey, typeof hsl>,
);

const weight = z.number().int().min(100).max(900).multipleOf(100);

// Themes saved before the button tokens existed lack them; their buttons were
// painted with primary, so default to that and the look is unchanged.
function withButtonDefaults(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const t = input as Record<string, unknown>;
  const fill = (set: unknown) => {
    if (!set || typeof set !== "object") return set;
    const c = set as Record<string, unknown>;
    return { ...c, button: c.button ?? c.primary, "button-foreground": c["button-foreground"] ?? c["primary-foreground"] };
  };
  return { ...t, light: fill(t.light), dark: fill(t.dark) };
}

export const PlatformThemeSchema = z.preprocess(
  withButtonDefaults,
  z.object({
    light: colorSet,
    dark: colorSet,
    fonts: z.object({ body: z.enum(FONT_CHOICES), heading: z.enum(FONT_CHOICES) }),
    headingWeight: weight.default(DEFAULT_THEME.headingWeight),
    buttonWeight: weight.default(DEFAULT_THEME.buttonWeight),
    adobeFontsProject: z.string().regex(ADOBE_PROJECT_PATTERN, "Expected 7-12 lowercase letters or digits").nullable().default(null),
    radius: z.number().min(0).max(1.5),
    shadowStrength: z.number().min(0).max(2),
  }),
);

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
  const fallback = ADOBE_FALLBACKS[name];
  if (fallback) return `"${ADOBE_FAMILY_NAMES[name] ?? name}", "${fallback}", sans-serif`;
  return `"${name}", ${SERIF_FONTS.has(name) ? "Georgia, serif" : "sans-serif"}`;
}

/**
 * Google Fonts stylesheet URL for the theme's fonts (the weights we use).
 * Adobe-only fonts are skipped; their Google fallback is included instead.
 */
export function googleFontsUrl(fonts: PlatformTheme["fonts"]): string {
  const names = [fonts.body, fonts.heading].map((f) => ADOBE_FALLBACKS[f] ?? f);
  const families = [...new Set(names)].map((f) => `family=${f.replace(/ /g, "+")}:wght@400;500;600;700`);
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
    `  --heading-weight: ${theme.headingWeight};`,
    `  --button-weight: ${theme.buttonWeight};`,
    `  --radius: ${theme.radius}rem;`,
    ...Object.entries(shadow(theme.shadowStrength)).map(([k, v]) => `  --${k}: ${v};`),
  ].join("\n");
  return [
    ...(theme.adobeFontsProject && ADOBE_PROJECT_PATTERN.test(theme.adobeFontsProject) ? [`@import url("https://use.typekit.net/${theme.adobeFontsProject}.css");`] : []),
    `@import url("${googleFontsUrl(theme.fonts)}");`,
    `:root:root {\n${shared}\n${vars(theme.light)}\n}`,
    `:root:root.dark {\n${vars(theme.dark)}\n}`,
    "",
  ].join("\n");
}
