import type { RoleAssignment } from "./engine";
import { hslOf } from "./color-math";

type Item = { hex: string; h: number; s: number; l: number };

/**
 * A starting role assignment: lightest -> background, a saturated mid tone ->
 * secondary background, a dark low-saturation color -> headings, a light cool
 * color -> button, the most saturated mid/dark color -> brand. Each swatch is
 * used once while swatches remain; the pickiest roles choose first.
 */
export function suggestRoles(swatches: string[]): RoleAssignment {
  const items: Item[] = swatches.map((hex) => ({ hex, ...hslOf(hex) }));
  const free = new Set(items.map((i) => i.hex));
  const take = (score: (i: Item) => number) => {
    let best: Item | null = null;
    for (const i of items) {
      if (free.has(i.hex) && (!best || score(i) > score(best))) best = i;
    }
    if (best) free.delete(best.hex);
    return best?.hex;
  };
  const cool = (h: number) => Math.cos(((h - 210) * Math.PI) / 180);
  const out: RoleAssignment = {};
  const set = (role: keyof RoleAssignment, hex: string | undefined) => {
    if (hex) out[role] = hex;
  };
  set("background", take((i) => i.l));
  set("headings", take((i) => (1 - i.l) * 2 - i.s));
  set("brand", take((i) => i.s * (1 - Math.abs(i.l - 0.4) * 1.5)));
  set("secondary-background", take((i) => i.s - Math.abs(i.l - 0.55)));
  set("button", take((i) => cool(i.h) * 0.5 + i.l * 0.5));
  return out;
}
