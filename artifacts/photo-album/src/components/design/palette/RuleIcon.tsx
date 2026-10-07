import type { HarmonyRule } from "./engine";

// Display-only: where the rule's points sit around a ring, in degrees.
const ANGLES: Record<HarmonyRule, number[]> = {
  analogous: [0, 30, 60, -30, -60],
  monochromatic: [0, 0, 0, 0, 0],
  complementary: [0, 180, 20, 200, -20],
  "split-complementary": [0, 150, 210, 20, -20],
  triadic: [0, 120, 240, 15, 135],
  square: [0, 90, 180, 270, 45],
  compound: [0, 150, 210, 30, 180],
  shades: [0, 0, 0, 0, 0],
};

export function RuleIcon({ rule, className = "h-5 w-5" }: { rule: HarmonyRule; className?: string }) {
  const stacked = rule === "monochromatic" || rule === "shades";
  const pts = ANGLES[rule].map((deg, i) => {
    if (stacked) return { x: 12, y: 5 + i * 3.5, r: rule === "shades" ? 1.2 + i * 0.25 : 1.6 };
    const a = (deg * Math.PI) / 180;
    return { x: 12 + 8 * Math.cos(a), y: 12 - 8 * Math.sin(a), r: i === 0 ? 2.3 : 1.7 };
  });
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      {!stacked && <circle cx={12} cy={12} r={8} fill="none" stroke="currentColor" strokeOpacity={0.35} strokeWidth={1} />}
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={p.r} />
      ))}
    </svg>
  );
}
