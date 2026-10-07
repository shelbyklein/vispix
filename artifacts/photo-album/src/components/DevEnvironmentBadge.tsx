import { FlaskConical } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// Environment indicator (issue #130): a persistent "DEV" badge shown whenever
// the build runs with VITE_ENVIRONMENT=dev (set in the dev worktree's root
// .env). Prod never sets the flag, so prod renders nothing. Clicking the badge
// explains what the dev environment means for data safety.
export function DevEnvironmentBadge() {
  if (import.meta.env.VITE_ENVIRONMENT !== "dev") return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-warning/50 bg-warning/15 px-2 py-0.5 text-xs font-semibold tracking-wide text-warning-foreground hover:bg-warning/25"
          title="You're on the dev environment — click for details"
          data-testid="dev-environment-badge"
        >
          <FlaskConical className="h-3 w-3" />
          DEV
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 text-sm">
        <p className="font-semibold text-foreground">Dev environment</p>
        <p className="mt-1 text-muted-foreground">
          You're using the dev preview, not the live site.
        </p>
        <ul className="mt-2 space-y-2 text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">Separate database.</span>{" "}
            Dev runs on its own database cloned from prod — schema changes and
            destructive testing here never touch live data.
          </li>
          <li>
            <span className="font-medium text-foreground">Shared photo storage.</span>{" "}
            Image files are shared with prod, so deleting photos on dev removes
            the dev record but never the underlying file.
          </li>
        </ul>
      </PopoverContent>
    </Popover>
  );
}
