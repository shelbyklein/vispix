import { useState } from "react";
import { Link } from "wouter";
import { useServiceStatus, useOrgServiceStatus } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { CircleCheck, CircleAlert, CircleMinus, X, ChevronRight } from "lucide-react";

// A maintenance task worth surfacing (pending embeddings, duplicate groups, …).
export type ActionItem = { key: string; label: string; href: string };

// Notifications panel (issue #122): per-service readiness rows + optional
// maintenance action items. Two variants: "platform" (superadmin hub — AI = any
// org) and "org" (org admin hub — AI = the active org's own configuration).
// When everything is green the panel can be dismissed (persisted via
// `dismissKey`); it reappears on its own the moment anything needs attention.
export function ServiceReadinessCard({
  variant,
  enabled,
  actionItems = [],
  dismissKey,
}: {
  variant: "platform" | "org";
  enabled: boolean;
  actionItems?: ActionItem[];
  dismissKey?: string;
}) {
  const platform = useServiceStatus({ enabled: enabled && variant === "platform" });
  const org = useOrgServiceStatus({ enabled: enabled && variant === "org" });
  const { data, isLoading } = variant === "platform" ? platform : org;

  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (!dismissKey || typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(dismissKey) === "1";
    } catch {
      return false;
    }
  });

  if (isLoading || !data) {
    return <Skeleton className="h-24 w-full rounded-xl" data-testid="service-readiness-loading" />;
  }

  const allGood = data.ready && actionItems.length === 0;

  // Dismissal only silences the all-clear state — problems always resurface.
  if (allGood && dismissed) return null;

  function handleDismiss() {
    setDismissed(true);
    if (dismissKey) {
      try {
        window.localStorage.setItem(dismissKey, "1");
      } catch {
        /* best-effort */
      }
    }
  }

  const title = !data.ready
    ? "Setup incomplete"
    : actionItems.length > 0
      ? `Services configured — ${actionItems.length} maintenance item${actionItems.length !== 1 ? "s" : ""} to review`
      : variant === "platform"
        ? "Platform ready — all required services configured"
        : "Everything's configured — this organization is ready";

  return (
    <div className="relative rounded-xl border border-border bg-card p-4" data-testid="service-readiness">
      <div className="flex items-center gap-2 pr-8">
        {allGood ? (
          <CircleCheck className="h-5 w-5 text-success shrink-0" />
        ) : (
          <CircleAlert className="h-5 w-5 text-warning shrink-0" />
        )}
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>

      {allGood && dismissKey && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-2.5 right-2.5 h-7 w-7 text-muted-foreground"
          onClick={handleDismiss}
          title="Hide until something needs attention"
          data-testid="dismiss-readiness"
        >
          <X className="h-4 w-4" />
        </Button>
      )}

      <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
        {data.services.map((s) => (
          <div key={s.key} className="flex items-start gap-1.5 text-xs" data-testid={`service-${s.key}`}>
            {s.ok ? (
              <CircleCheck className="h-3.5 w-3.5 mt-0.5 text-success shrink-0" />
            ) : s.optional ? (
              <CircleMinus className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
            ) : (
              <CircleAlert className="h-3.5 w-3.5 mt-0.5 text-warning shrink-0" />
            )}
            <span>
              <span className="font-medium text-foreground">
                {s.label}
                {s.optional && <span className="text-muted-foreground font-normal"> (optional)</span>}
              </span>{" "}
              <span className="text-muted-foreground">— {s.detail}</span>
            </span>
          </div>
        ))}
      </div>

      {actionItems.length > 0 && (
        <div className="mt-3 border-t border-border pt-3" data-testid="action-items">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
            Action items
          </p>
          <div className="grid gap-1 sm:grid-cols-2">
            {actionItems.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                className="group inline-flex items-center gap-1.5 text-xs text-warning font-medium hover:underline"
                data-testid={`action-item-${item.key}`}
              >
                <CircleAlert className="h-3.5 w-3.5 shrink-0" />
                {item.label}
                <ChevronRight className="h-3 w-3 opacity-0 -translate-x-0.5 transition-all group-hover:opacity-100 group-hover:translate-x-0" />
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
