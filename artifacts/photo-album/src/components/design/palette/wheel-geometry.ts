import type { WheelPoint } from "./engine";

// Convention assumed to match the palette engine: hue 0 = red at 3 o'clock,
// hue increasing counter-clockwise (math angle, y up); saturation is the
// distance from the center as a fraction of the radius. If the engine turns
// out to go the other way, flip HUE_DIRECTION and nothing else.
export const HUE_DIRECTION: 1 | -1 = 1;

function angleOf(hue: number) {
  const a = (HUE_DIRECTION * hue * Math.PI) / 180;
  return { x: Math.cos(a), y: -Math.sin(a) }; // screen y grows downward
}

/** Position in a box of `size` px for a wheel point. */
export function pointToXY(p: WheelPoint, size: number) {
  const r = size / 2;
  const v = angleOf(p.hue);
  return { x: r + v.x * p.saturation * r, y: r + v.y * p.saturation * r };
}

export function xyToPoint(x: number, y: number, size: number): WheelPoint {
  const r = size / 2;
  const dx = x - r;
  const dy = -(y - r);
  const hue = (((HUE_DIRECTION * Math.atan2(dy, dx) * 180) / Math.PI) % 360 + 360) % 360;
  return { hue, saturation: Math.min(1, Math.hypot(dx, dy) / r) };
}

/** CSS conic gradient showing each screen angle's hue (CSS angles run clockwise from 12 o'clock). */
export function wheelConicGradient() {
  const stops: string[] = [];
  for (let c = 0; c <= 360; c += 15) {
    const hue = ((((90 - c) * HUE_DIRECTION) % 360) + 360) % 360;
    stops.push(`hsl(${hue} 100% 50%) ${c}deg`);
  }
  return `conic-gradient(${stops.join(", ")})`;
}
