import type { ColorSet } from "@workspace/api-zod/theme";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { contrastRatio } from "./color-utils";

// [foreground, background, label, minimum ratio]. Large-text pairs (headings)
// only need 3:1 under WCAG AA; everything else 4.5:1.
const PAIRS: [keyof ColorSet, keyof ColorSet, string, number][] = [
  ["foreground", "background", "Body text on page", 4.5],
  ["card-foreground", "card", "Card text on card", 4.5],
  ["primary-foreground", "primary", "Text on primary", 4.5],
  ["secondary-foreground", "secondary", "Text on secondary", 4.5],
  ["accent-foreground", "accent", "Text on accent", 4.5],
  ["destructive-foreground", "destructive", "Text on danger", 4.5],
  ["warning", "background", "Warning on page", 4.5],
  ["success", "background", "Success on page", 4.5],
  ["muted-foreground", "background", "Secondary text on page", 4.5],
  ["sidebar-foreground", "sidebar", "Sidebar text", 4.5],
  ["heading-primary", "background", "Page title (large)", 3],
  ["heading-secondary", "background", "Headings (large)", 3],
];

export function contrastFailures(colors: ColorSet): number {
  return PAIRS.filter(([fg, bg, , min]) => {
    const r = contrastRatio(colors[fg], colors[bg]);
    return r !== null && r < min;
  }).length;
}

export function ContrastChecks({ colors, mode }: { colors: ColorSet; mode: "light" | "dark" }) {
  return (
    <ul className="space-y-1" data-testid="contrast-checks" aria-label={`Contrast checks, ${mode} mode`}>
      {PAIRS.map(([fg, bg, label, min]) => {
        const r = contrastRatio(colors[fg], colors[bg]);
        const ok = r === null || r >= min;
        return (
          <li key={fg + bg} className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">{label}</span>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${
                ok ? "bg-success/10 text-success" : "bg-warning/10 text-warning"
              }`}
              data-testid={ok ? undefined : "contrast-warning"}
            >
              {ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
              {r === null ? "n/a" : `${r.toFixed(1)}:1`}
              {!ok && ` (needs ${min})`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
