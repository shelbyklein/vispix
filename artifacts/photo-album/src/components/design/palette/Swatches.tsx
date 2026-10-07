import { Check, Copy, Crosshair } from "lucide-react";
import { useState } from "react";
import { simulateColorVision, type ColorVision } from "./engine";
import { readableOn } from "./color-math";
import { useToast } from "@/hooks/use-toast";

export function PaletteStrip({ swatches, vision = "normal", className = "h-8" }: { swatches: string[]; vision?: ColorVision; className?: string }) {
  return (
    <div className={`flex overflow-hidden rounded-md ring-1 ring-border ${className}`} aria-hidden>
      {swatches.map((hex, i) => (
        <div key={`${hex}-${i}`} className="flex-1" style={{ backgroundColor: simulateColorVision(hex, vision) }} />
      ))}
    </div>
  );
}

/** Tall swatches side by side: hex, copy button, a target on the base. Click selects. */
export function Swatches({
  swatches,
  selected,
  onSelect,
  vision,
}: {
  swatches: string[];
  selected: number;
  onSelect: (index: number) => void;
  vision: ColorVision;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = useState<number | null>(null);

  async function copy(hex: string, i: number) {
    try {
      await navigator.clipboard.writeText(hex);
      setCopied(i);
      setTimeout(() => setCopied((c) => (c === i ? null : c)), 1200);
    } catch {
      toast({ title: "Could not copy", description: "Clipboard access was denied.", variant: "destructive" });
    }
  }

  return (
    <div className="flex h-56 gap-1.5 sm:h-64" role="listbox" aria-label="Palette swatches" data-testid="palette-swatches">
      {swatches.map((hex, i) => {
        const shown = simulateColorVision(hex, vision);
        const ink = readableOn(shown);
        const active = i === selected;
        return (
          <div
            key={`${hex}-${i}`}
            role="option"
            aria-selected={active}
            tabIndex={0}
            onClick={() => onSelect(i)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(i);
              }
            }}
            className={`relative flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-between rounded-lg p-2 outline-none ring-offset-2 ring-offset-background transition-all focus-visible:ring-2 focus-visible:ring-ring ${active ? "ring-2 ring-foreground" : "ring-1 ring-border"}`}
            style={{ backgroundColor: shown, color: ink }}
            data-testid={`palette-swatch-${i}`}
          >
            <span className="flex h-5 items-center" aria-hidden>
              {i === 0 && <Crosshair className="h-4 w-4" aria-label="Base color" />}
            </span>
            <div className="flex w-full flex-col items-center gap-1">
              <span className="max-w-full truncate font-mono text-xs font-medium">{hex.replace("#", "")}</span>
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-current"
                style={{ color: ink }}
                aria-label={`Copy ${hex}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void copy(hex, i);
                }}
              >
                {copied === i ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
