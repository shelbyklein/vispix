import { lazy, Suspense, useState } from "react";
import { X, Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCreatePanelOpen, createPanel } from "@/lib/create-panel";
import { useIsMobile } from "@/hooks/use-mobile";

// Persisted panel width (drag the left edge to resize).
const WIDTH_KEY = "tv.createPanelWidth";
const MIN_WIDTH = 360;
const DEFAULT_WIDTH = 520;

function maxWidth(): number {
  return Math.min(900, Math.round(window.innerWidth * 0.6));
}

function initialWidth(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(raw)) return Math.min(maxWidth(), Math.max(MIN_WIDTH, raw));
  } catch {
    /* ignore */
  }
  return DEFAULT_WIDTH;
}

// Desktop Create slide-out (#167 UX): the workspace docks to the right edge as
// a non-modal panel, so the rest of the app stays visible and browsable while
// planning/generating. Mobile keeps the full /create page. Lazily loaded so
// the Create chunk only downloads when the panel is first opened.
const LazyWorkspace = lazy(() =>
  import("@/pages/create").then((m) => ({ default: m.CreateWorkspace })),
);

export function CreatePanel() {
  const open = useCreatePanelOpen();
  const isMobile = useIsMobile();
  const [width, setWidth] = useState<number>(initialWidth);
  const [resizing, setResizing] = useState(false);

  if (isMobile || !open) return null;

  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setResizing(true);
    const onMove = (ev: PointerEvent) => {
      setWidth(Math.min(maxWidth(), Math.max(MIN_WIDTH, window.innerWidth - ev.clientX)));
    };
    const onUp = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      setResizing(false);
      setWidth((w) => {
        try {
          localStorage.setItem(WIDTH_KEY, String(w));
        } catch {
          /* ignore */
        }
        return w;
      });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  return (
    // Docked, not overlaid: the panel is a flex sibling of the main content
    // inside the sidebar layout's flex row, so opening it squeezes the body
    // instead of covering it. Sticky + h-svh keeps it viewport-height while
    // the page scrolls. The left edge is a drag handle for resizing.
    <aside
      className="relative sticky top-0 flex h-svh shrink-0 flex-col border-l border-border bg-background"
      style={{ width }}
      data-testid="create-panel"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Create panel"
        onPointerDown={startResize}
        className={`absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize transition-colors hover:bg-primary/30 ${resizing ? "bg-primary/40" : ""}`}
        data-testid="create-panel-resize"
      />
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Sparkles className="h-4 w-4 text-primary" /> Create
        </h2>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={() => createPanel.set(false)}
          aria-label="Close Create panel"
          data-testid="create-panel-close"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-3">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          }
        >
          <LazyWorkspace compact className="h-full" />
        </Suspense>
      </div>
    </aside>
  );
}
