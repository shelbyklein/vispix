import { useRef } from "react";
import { hexToWheel, type WheelPoint } from "./engine";
import { pointToXY, wheelConicGradient, xyToPoint } from "./wheel-geometry";
import { readableOn } from "./color-math";

const KEY_STEP = 1.5; // percent of the wheel's width per arrow press
const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * Hue/saturation wheel with one draggable handle per swatch, each tied to the
 * center by a thin line. Positions are percentages of the wheel box so it
 * scales with its container.
 */
export function ColorWheel({
  swatches,
  selected,
  onSelect,
  onMove,
}: {
  swatches: string[];
  selected: number;
  onSelect: (index: number) => void;
  onMove: (index: number, to: WheelPoint) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);

  function pointFromEvent(e: React.PointerEvent) {
    const rect = boxRef.current!.getBoundingClientRect();
    return xyToPoint(((e.clientX - rect.left) / rect.width) * 100, ((e.clientY - rect.top) / rect.height) * 100, 100);
  }

  return (
    <div
      ref={boxRef}
      className="relative aspect-square w-full max-w-[22rem] touch-none select-none rounded-full shadow-md ring-1 ring-border"
      style={{ backgroundImage: wheelConicGradient() }}
      data-testid="palette-wheel"
      onPointerMove={(e) => {
        if (drag.current !== null) onMove(drag.current, pointFromEvent(e));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      <div className="pointer-events-none absolute inset-0 rounded-full" style={{ backgroundImage: "radial-gradient(circle closest-side, #fff 0%, rgb(255 255 255 / 0) 100%)" }} />
      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" aria-hidden>
        {swatches.map((hex, i) => {
          const { x, y } = pointToXY(hexToWheel(hex), 100);
          return <line key={i} x1={50} y1={50} x2={x} y2={y} stroke={i === selected ? "#fff" : "rgb(255 255 255 / 0.7)"} strokeWidth={i === selected ? 0.7 : 0.4} style={{ filter: "drop-shadow(0 0 0.5px rgb(0 0 0 / 0.6))" }} />;
        })}
        <circle cx={50} cy={50} r={1.1} fill="#fff" stroke="rgb(0 0 0 / 0.35)" strokeWidth={0.3} />
      </svg>
      {swatches.map((hex, i) => {
        const pt = hexToWheel(hex);
        const { x, y } = pointToXY(pt, 100);
        const active = i === selected;
        return (
          <button
            key={i}
            type="button"
            className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-md outline-none transition-[width,height] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${active ? "z-10 h-9 w-9" : "h-6 w-6"}`}
            style={{ left: `${x}%`, top: `${y}%`, backgroundColor: hex, boxShadow: active ? "0 0 0 2px rgb(0 0 0 / 0.55), 0 2px 6px rgb(0 0 0 / 0.4)" : undefined }}
            aria-label={`Swatch ${i + 1}${i === 0 ? " (base)" : ""}, ${hex}. Use arrow keys to move on the wheel.`}
            data-testid={`wheel-handle-${i}`}
            onPointerDown={(e) => {
              e.preventDefault();
              (e.currentTarget as HTMLElement).focus();
              boxRef.current?.setPointerCapture(e.pointerId);
              drag.current = i;
              onSelect(i);
            }}
            onFocus={() => onSelect(i)}
            onKeyDown={(e) => {
              const d = ARROWS[e.key];
              if (!d) return;
              e.preventDefault();
              const step = e.shiftKey ? KEY_STEP * 3 : KEY_STEP;
              const cur = pointToXY(pt, 100);
              onMove(i, xyToPoint(cur.x + d[0] * step, cur.y + d[1] * step, 100));
            }}
          >
            {active && (
              <span className="absolute inset-1.5 rounded-full border-2" style={{ borderColor: readableOn(hex) }} aria-hidden />
            )}
          </button>
        );
      })}
    </div>
  );
}
