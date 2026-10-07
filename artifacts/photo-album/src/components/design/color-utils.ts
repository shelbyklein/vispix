import { HSL_PATTERN } from "@workspace/api-zod/theme";

export type Hsl = { h: number; s: number; l: number };

const trim = (n: number) => String(Math.round(n * 10) / 10);

export function parseHsl(value: string): Hsl | null {
  if (!HSL_PATTERN.test(value)) return null;
  const [h, s, l] = value.split(" ").map((p) => parseFloat(p));
  if (h > 360 || s > 100 || l > 100) return null;
  return { h, s, l };
}

export function formatHsl({ h, s, l }: Hsl): string {
  return `${trim(h)} ${trim(s)}% ${trim(l)}%`;
}

export function hslToRgb({ h, s, l }: Hsl): [number, number, number] {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

export function hslStringToHex(value: string): string {
  const hsl = parseHsl(value);
  if (!hsl) return "#000000";
  return (
    "#" +
    hslToRgb(hsl)
      .map((c) => Math.round(c).toString(16).padStart(2, "0"))
      .join("")
  );
}

export function hexToHslString(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "0 0% 0%";
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return formatHsl({ h, s: s * 100, l: l * 100 });
}

function luminance(hsl: Hsl): number {
  const [r, g, b] = hslToRgb(hsl).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two "H S% L%" colors (1-21). */
export function contrastRatio(a: string, b: string): number | null {
  const ha = parseHsl(a);
  const hb = parseHsl(b);
  if (!ha || !hb) return null;
  const la = luminance(ha);
  const lb = luminance(hb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
