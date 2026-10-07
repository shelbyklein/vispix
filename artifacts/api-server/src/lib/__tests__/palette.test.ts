import { describe, expect, it } from "vitest";
import {
  HARMONY_RULES,
  PALETTE_SIZE,
  contrastRatio,
  deriveTheme,
  extractPalette,
  harmony,
  hexToWheel,
  moveOnWheel,
  simulateColorVision,
  wheelToHex,
  type HarmonyRule,
  type RoleAssignment,
} from "@workspace/api-zod/palette";
import { DEFAULT_THEME, PlatformThemeSchema, type ColorSet } from "@workspace/api-zod/theme";

// Independent HSL-string -> hex so the tests don't lean on the engine's helpers.
function hslToHex(value: string): string {
  const [h, s, l] = value.replace(/%/g, "").split(" ").map(Number) as [number, number, number];
  const S = s / 100, L = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const x = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${x(f(0))}${x(f(8))}${x(f(4))}`.toUpperCase();
}

const hueOf = (hex: string) => hexToWheel(hex).hue;
const hueDiff = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};
const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

describe("contrastRatio", () => {
  it("matches known values", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#3E5A7A", "#3E5A7A")).toBe(1);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 1);
  });
});

describe("wheel", () => {
  it("uses the red 0, yellow 60, green 120 hue order", () => {
    expect(hueOf("#FF0000")).toBeCloseTo(0, 0);
    expect(hueOf("#FFFF00")).toBeCloseTo(60, 0);
    expect(hueOf("#00FF00")).toBeCloseTo(120, 0);
    expect(hueOf("#00FFFF")).toBeCloseTo(180, 0);
    expect(hueOf("#0000FF")).toBeCloseTo(240, 0);
    expect(hueOf("#FF00FF")).toBeCloseTo(300, 0);
    expect(hexToWheel("#808080").saturation).toBe(0);
    expect(hexToWheel("#FF0000").saturation).toBe(1);
  });

  it("round-trips hex -> wheel -> hex at the same lightness", () => {
    for (const hex of ["#3E5A7A", "#E9C18D", "#D9534F", "#2E8B57", "#7A3EDB"]) {
      const p = hexToWheel(hex);
      const back = wheelToHex(p, 0.6);
      const again = hexToWheel(back);
      expect(hueDiff(again.hue, p.hue)).toBeLessThan(2);
      expect(Math.abs(again.saturation - p.saturation)).toBeLessThan(0.03);
    }
    // At the color's own lightness it is exact.
    expect(wheelToHex(hexToWheel("#E63946"), (0xe6 + 0x39) / 2 / 255)).toBe("#E63946");
  });

  it("wheelToHex defaults to lightness 0.6 and wraps hue", () => {
    expect(wheelToHex({ hue: 0, saturation: 1 })).toBe("#FF3333");
    expect(wheelToHex({ hue: 360, saturation: 1 })).toBe(wheelToHex({ hue: 0, saturation: 1 }));
    expect(wheelToHex({ hue: -120, saturation: 1 })).toBe(wheelToHex({ hue: 240, saturation: 1 }));
  });
});

describe("harmony", () => {
  const base = "#3e8ede";
  const expected: Record<HarmonyRule, number[][]> = {
    // Each entry: hue offsets that must all appear among swatches 1..4.
    analogous: [[30], [-30], [60], [-60]],
    monochromatic: [[0], [0], [0], [0]],
    complementary: [[180]],
    "split-complementary": [[150], [210]],
    triadic: [[120], [240]],
    square: [[90], [180], [270]],
    compound: [[180]],
    shades: [[0], [0], [0], [0]],
  };

  it.each(HARMONY_RULES.map((r) => r.rule))("%s returns %d swatches with the base first", (rule) => {
    const p = harmony(base, rule);
    expect(p).toHaveLength(PALETTE_SIZE);
    expect(p[0]).toBe("#3E8EDE");
    for (const c of p) expect(c).toMatch(/^#[0-9A-F]{6}$/);
    expect(harmony(base, rule)).toEqual(p); // deterministic
  });

  it.each(HARMONY_RULES.map((r) => r.rule))("%s hits its rule angles", (rule) => {
    const p = harmony(base, rule);
    const baseHue = hueOf(base);
    const diffs = p.slice(1).map((c) => hueOf(c) - baseHue);
    for (const [off] of expected[rule]) {
      expect(diffs.some((d) => hueDiff(d, off!) < 4), `${rule} missing ${off}: ${diffs.join(",")}`).toBe(true);
    }
    if (rule === "monochromatic" || rule === "shades") {
      for (const d of diffs) expect(hueDiff(d, 0)).toBeLessThan(4);
    }
  });

  it("is not flat: swatches differ in lightness or saturation", () => {
    for (const { rule } of HARMONY_RULES) {
      const p = harmony(base, rule);
      expect(new Set(p).size).toBe(PALETTE_SIZE);
    }
  });

  it("shades keep hue and saturation and step lightness", () => {
    const p = harmony("#3E8EDE", "shades");
    const sats = p.map((c) => hexToWheel(c).saturation);
    for (const s of sats) expect(Math.abs(s - sats[0]!)).toBeLessThan(0.03);
    const lum = p.slice(1).map((c) => channels(c).reduce((a, b) => a + b, 0));
    expect(new Set(lum).size).toBe(4);
  });

  it("handles extreme bases", () => {
    for (const b of ["#000000", "#FFFFFF", "#808080", "#FF0000"]) {
      for (const { rule } of HARMONY_RULES) expect(harmony(b, rule)).toHaveLength(PALETTE_SIZE);
    }
  });
});

describe("moveOnWheel", () => {
  const lightnessOf = (hex: string) => {
    const [r, g, b] = channels(hex).map((v) => v / 255) as [number, number, number];
    return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
  };

  it.each(["analogous", "complementary", "split-complementary", "triadic", "square", "compound"] as HarmonyRule[])(
    "%s keeps angular offsets and lightness",
    (rule) => {
      const p = harmony("#3E8EDE", rule);
      for (const index of [0, 1, 2]) {
        const to = { hue: 100, saturation: 0.8 };
        const moved = moveOnWheel(p, rule, index, to);
        expect(moved).toHaveLength(p.length);
        expect(hueDiff(hueOf(moved[index]!), 100)).toBeLessThan(3);
        const baseHue = hueOf(moved[0]!);
        const before = p.map((c) => hueOf(c) - hueOf(p[0]!));
        moved.forEach((c, i) => {
          expect(hueDiff(hueOf(c) - baseHue, before[i]!)).toBeLessThan(4);
          expect(Math.abs(lightnessOf(c) - lightnessOf(p[i]!))).toBeLessThan(0.02);
        });
      }
    },
  );

  it("shares hue and saturation for monochromatic and shades", () => {
    for (const rule of ["monochromatic", "shades"] as HarmonyRule[]) {
      const p = harmony("#3E8EDE", rule);
      const moved = moveOnWheel(p, rule, 2, { hue: 20, saturation: 0.7 });
      for (const c of moved) {
        expect(hueDiff(hueOf(c), 20)).toBeLessThan(4);
        expect(Math.abs(hexToWheel(c).saturation - 0.7)).toBeLessThan(0.05);
      }
      moved.forEach((c, i) => expect(Math.abs(lightnessOf(c) - lightnessOf(p[i]!))).toBeLessThan(0.02));
    }
  });

  it("moving the base to its own position is (nearly) a no-op", () => {
    const p = harmony("#3E8EDE", "triadic");
    const moved = moveOnWheel(p, "triadic", 0, hexToWheel(p[0]!));
    moved.forEach((c, i) => channels(c).forEach((v, k) => expect(Math.abs(v - channels(p[i]!)[k]!)).toBeLessThan(6)));
  });
});

describe("extractPalette", () => {
  function image(blocks: { hex: string; pixels: number; alpha?: number }[]) {
    const total = blocks.reduce((a, b) => a + b.pixels, 0);
    const data = new Uint8ClampedArray(total * 4);
    let p = 0;
    for (const b of blocks) {
      const [r, g, bl] = channels(b.hex) as [number, number, number];
      for (let i = 0; i < b.pixels; i++, p++) data.set([r, g, bl, b.alpha ?? 255], p * 4);
    }
    return data;
  }
  const near = (a: string, b: string, tol = 3) => channels(a).every((v, i) => Math.abs(v - channels(b)[i]!) <= tol);

  it("finds three color blocks, largest first", () => {
    const data = image([
      { hex: "#2A9D8F", pixels: 3000 },
      { hex: "#E76F51", pixels: 5000 },
      { hex: "#264653", pixels: 1500 },
    ]);
    const out = extractPalette(data, 5);
    expect(out).toHaveLength(3);
    expect(near(out[0]!, "#E76F51")).toBe(true);
    expect(near(out[1]!, "#2A9D8F")).toBe(true);
    expect(near(out[2]!, "#264653")).toBe(true);
    expect(extractPalette(data, 5)).toEqual(out); // deterministic
  });

  it("handles big images (downsampling) and respects count", () => {
    const data = image([
      { hex: "#FF0000", pixels: 90000 },
      { hex: "#00FF00", pixels: 40000 },
      { hex: "#0000FF", pixels: 20000 },
    ]);
    expect(extractPalette(data, 2)).toHaveLength(2);
    const out = extractPalette(data, 3);
    expect(out).toHaveLength(3);
    expect(near(out[0]!, "#FF0000", 8)).toBe(true);
    expect(near(out[1]!, "#00FF00", 8)).toBe(true);
    expect(near(out[2]!, "#0000FF", 8)).toBe(true);
  });

  it("returns one color for a solid image and none for a transparent one", () => {
    expect(extractPalette(image([{ hex: "#123456", pixels: 400 }]), 5)).toEqual(["#123456"]);
    expect(extractPalette(image([{ hex: "#123456", pixels: 400, alpha: 0 }]), 5)).toEqual([]);
    expect(extractPalette(new Uint8ClampedArray(0))).toEqual([]);
  });

  it("ignores transparent pixels next to opaque ones", () => {
    const out = extractPalette(image([{ hex: "#FF0000", pixels: 500, alpha: 10 }, { hex: "#00AA00", pixels: 100 }]));
    expect(out).toHaveLength(1);
    expect(near(out[0]!, "#00AA00")).toBe(true);
  });

  it("merges near-duplicate colors", () => {
    const out = extractPalette(image([{ hex: "#C0392B", pixels: 500 }, { hex: "#C23A2D", pixels: 500 }, { hex: "#2980B9", pixels: 300 }]), 5);
    expect(out).toHaveLength(2);
  });
});

describe("simulateColorVision", () => {
  it("normal is identity (uppercase)", () => {
    expect(simulateColorVision("#3e5a7a", "normal")).toBe("#3E5A7A");
  });

  it("achromatopsia gives gray", () => {
    for (const hex of ["#FF0000", "#3E5A7A", "#E9C18D"]) {
      const [r, g, b] = channels(simulateColorVision(hex, "achromatopsia"));
      expect(r).toBe(g);
      expect(g).toBe(b);
    }
    expect(simulateColorVision("#FFFFFF", "achromatopsia")).toBe("#FFFFFF");
    expect(simulateColorVision("#000000", "achromatopsia")).toBe("#000000");
  });

  it("protanopia and deuteranopia pull red and green together; grays stay gray", () => {
    for (const vision of ["protanopia", "deuteranopia"] as const) {
      const red = channels(simulateColorVision("#FF0000", vision));
      const green = channels(simulateColorVision("#00B050", vision));
      const normalGap = Math.hypot(...channels("#FF0000").map((v, i) => v - channels("#00B050")[i]!));
      const gap = Math.hypot(...red.map((v, i) => v - green[i]!));
      expect(gap).toBeLessThan(normalGap * 0.6);
      const [r, g, b] = channels(simulateColorVision("#808080", vision));
      expect(Math.abs(r - g)).toBeLessThan(3);
      expect(Math.abs(g - b)).toBeLessThan(3);
    }
  });

  it("tritanopia changes blue noticeably but keeps white", () => {
    expect(simulateColorVision("#0000FF", "tritanopia")).not.toBe("#0000FF");
    expect(simulateColorVision("#FFFFFF", "tritanopia")).toBe("#FFFFFF");
  });
});

describe("deriveTheme", () => {
  const sunset: RoleAssignment = {
    background: "#FCFCFC",
    "secondary-background": "#E9C18D",
    headings: "#5F696E",
    button: "#CCD8E5",
    brand: "#3E5A7A",
  };

  function assertContrast(set: ColorSet, label: string) {
    const c = (a: keyof ColorSet, b: keyof ColorSet, min: number) => {
      const ratio = contrastRatio(hslToHex(set[a]), hslToHex(set[b]));
      expect(ratio, `${label}: ${a} on ${b} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min);
    };
    c("foreground", "background", 4.5);
    c("card-foreground", "card", 4.5);
    c("popover-foreground", "popover", 4.5);
    // One text color can only serve surfaces on the same side of the luminance
    // flip point (~0.18); a background and a secondary background on opposite
    // sides get the best black/white instead.
    const mutedBgs = (["background", "card", "muted", "sidebar"] as const).map((k) => hslToHex(set[k]));
    const worst = (fg: string) => Math.min(...mutedBgs.map((b) => contrastRatio(fg, b)));
    const bestPossible = Math.max(worst("#000000"), worst("#FFFFFF"));
    const mutedWorst = worst(hslToHex(set["muted-foreground"]));
    expect(mutedWorst, `${label}: muted-foreground worst ${mutedWorst.toFixed(2)}`).toBeGreaterThanOrEqual(Math.min(4.5, bestPossible) - 0.01);
    c("primary", "background", 4.5);
    c("primary", "card", 4.5);
    c("primary-foreground", "primary", 4.5);
    c("button-foreground", "button", 4.5);
    c("secondary-foreground", "secondary", 4.5);
    c("accent-foreground", "accent", 4.5);
    c("sidebar-foreground", "sidebar", 4.5);
    c("sidebar-foreground", "sidebar-accent", 4.5);
    c("sidebar-accent-foreground", "sidebar-accent", 4.5);
    c("sidebar-primary-foreground", "sidebar-primary", 4.5);
    c("heading-primary", "background", 3);
    c("heading-secondary", "background", 3);
  }

  function check(roles: RoleAssignment, label: string) {
    const t = deriveTheme(DEFAULT_THEME, roles);
    expect(PlatformThemeSchema.safeParse(t).success, `${label}: schema`).toBe(true);
    assertContrast(t.light, `${label} light`);
    assertContrast(t.dark, `${label} dark`);
    return t;
  }

  const near = (a: string, b: string, tol = 2) => channels(a).every((v, i) => Math.abs(v - channels(b)[i]!) <= tol);

  it("(c) no roles returns the base colors unchanged", () => {
    const t = deriveTheme(DEFAULT_THEME, {});
    expect(t).toEqual(DEFAULT_THEME);
    expect(t).not.toBe(DEFAULT_THEME);
    expect(t.light).not.toBe(DEFAULT_THEME.light);
    expect(PlatformThemeSchema.safeParse(t).success).toBe(true);
  });

  it("(a) the Sunset roles produce a contrast-safe theme in both modes", () => {
    const t = check(sunset, "sunset");
    expect(near(hslToHex(t.light.background), "#FCFCFC")).toBe(true);
    expect(near(hslToHex(t.light.secondary), "#E9C18D")).toBe(true);
    expect(near(hslToHex(t.light.sidebar), "#E9C18D")).toBe(true);
    expect(near(hslToHex(t.light.button), "#CCD8E5")).toBe(true);
    expect(near(hslToHex(t.light.primary), "#3E5A7A")).toBe(true); // already passes, not darkened
    expect(near(hslToHex(t.light["heading-primary"]), "#5F696E")).toBe(true);
    expect(contrastRatio(hslToHex(t.light.foreground), hslToHex(t.light.background))).toBeGreaterThanOrEqual(7);
    // Non-color fields come from the base.
    expect(t.fonts).toEqual(DEFAULT_THEME.fonts);
    expect(t.radius).toBe(DEFAULT_THEME.radius);
    expect(t.shadowStrength).toBe(DEFAULT_THEME.shadowStrength);
    expect(t.headingWeight).toBe(DEFAULT_THEME.headingWeight);
    expect(t.buttonWeight).toBe(DEFAULT_THEME.buttonWeight);
    expect(t.adobeFontsProject).toBe(DEFAULT_THEME.adobeFontsProject);
    // Status colors stay.
    expect(t.light.destructive).toBe(DEFAULT_THEME.light.destructive);
    expect(t.dark.success).toBe(DEFAULT_THEME.dark.success);
    // Dark mode is dark with light text.
    expect(contrastRatio(hslToHex(t.dark.background), "#FFFFFF")).toBeGreaterThan(14);
  });

  it("(b) a yellow brand is darkened only as far as needed", () => {
    const t = check({ background: "#FFFFFF", brand: "#FFD400" }, "yellow");
    const primary = hslToHex(t.light.primary);
    expect(primary).not.toBe("#FFD400");
    expect(contrastRatio(primary, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(primary, "#FFFFFF")).toBeLessThan(5.2); // not over-darkened
    expect(t.light.ring).toBe(t.light.primary);
    expect(t.light["sidebar-primary"]).toBe(t.light.primary);
    expect(t.light["chart-1"]).toBe(t.light.primary);
    // Dark mode keeps it bright.
    expect(contrastRatio(hslToHex(t.dark.primary), hslToHex(t.dark.background))).toBeGreaterThanOrEqual(4.5);
  });

  it("(d) saturated role sets pass in both modes", () => {
    check({ background: "#FF3399", "secondary-background": "#00C8FF", headings: "#FFFF00", button: "#8A00FF", brand: "#00FF66" }, "saturated-1");
    check({ background: "#1E90FF", "secondary-background": "#FF4500", headings: "#7FFF00", button: "#FF1493", brand: "#FFD700" }, "saturated-2");
    check({ background: "#0A0A23", "secondary-background": "#2B2B6B", headings: "#FFFFFF", button: "#F5F5F5", brand: "#6C63FF" }, "dark-ish");
    check({ background: "#7A7A7A" }, "mid-gray");
    check({ brand: "#00E5FF" }, "brand-only");
    check({ headings: "#FFFF00", button: "#001F3F" }, "headings-button-only");
  });

  it("(d) many pseudo-random palettes pass", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const color = () => `#${Math.floor(rnd() * 0xffffff).toString(16).padStart(6, "0")}`.toUpperCase();
    for (let i = 0; i < 150; i++) {
      check({ background: color(), "secondary-background": color(), headings: color(), button: color(), brand: color() }, `random-${i}`);
    }
  });

  it("leaves tokens of unassigned roles alone", () => {
    const t = deriveTheme(DEFAULT_THEME, { brand: "#3E5A7A" });
    expect(t.light.background).toBe(DEFAULT_THEME.light.background);
    expect(t.light.sidebar).toBe(DEFAULT_THEME.light.sidebar);
    expect(t.light.button).toBe(DEFAULT_THEME.light.button);
    expect(t.dark.background).toBe(DEFAULT_THEME.dark.background);
    expect(t.dark.secondary).toBe(DEFAULT_THEME.dark.secondary);
  });

  it("emits HSL strings with at most one decimal", () => {
    const t = deriveTheme(DEFAULT_THEME, sunset);
    for (const set of [t.light, t.dark]) {
      for (const v of Object.values(set)) expect(v).toMatch(/^\d{1,3}(\.\d)? \d{1,3}(\.\d)?% \d{1,3}(\.\d)?%$/);
    }
  });
});
