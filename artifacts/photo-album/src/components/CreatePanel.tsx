import { lazy, Suspense } from "react";
import { X, Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCreatePanelOpen, createPanel } from "@/lib/create-panel";
import { useIsMobile } from "@/hooks/use-mobile";

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

  if (isMobile || !open) return null;

  return (
    // Docked, not overlaid: the panel is a flex sibling of the main content
    // inside the sidebar layout's flex row, so opening it squeezes the body
    // instead of covering it. Sticky + h-svh keeps it viewport-height while
    // the page scrolls.
    <aside
      className="sticky top-0 flex h-svh w-[480px] shrink-0 flex-col border-l border-border bg-background xl:w-[560px]"
      data-testid="create-panel"
    >
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
