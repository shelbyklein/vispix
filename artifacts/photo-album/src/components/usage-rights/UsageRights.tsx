import { Link } from "wouter";
import { AlertTriangle, Check, Copyright } from "lucide-react";
import { cn } from "@/lib/utils";

// Usage rights at decision points (#207, docs/USAGE_RIGHTS.md). "Not recorded"
// is unknown — nobody has recorded rights — and is always shown, never hidden.
// Recorded tags are the team's own record, not a legal clearance. Warning-only:
// nothing here blocks an action.

export interface UsageRightsValue {
  status: "recorded" | "not_recorded";
  tags: { id: number; name: string }[];
}

/** The photo's rights; falls back to its tags for older cached responses. */
export function usageRightsOf(photo: { usageRights?: UsageRightsValue | null; attributionTags?: { id: number; name: string }[] | null }): UsageRightsValue {
  if (photo.usageRights) return photo.usageRights;
  const tags = photo.attributionTags ?? [];
  return { status: tags.length > 0 ? "recorded" : "not_recorded", tags };
}

export const RIGHTS_DISCLAIMER = "Recorded by your team · not a legal clearance";

/** Compact status pill(s): an amber warning, or the recorded tag names. */
export function RightsPills({
  rights,
  tone = "default",
  className,
  testId,
}: {
  rights: UsageRightsValue;
  tone?: "default" | "dark";
  className?: string;
  testId?: string;
}) {
  if (rights.status === "not_recorded") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
          tone === "dark"
            ? "border-warning/50 bg-warning/15 text-amber-200"
            : "border-warning/40 bg-warning/10 text-warning-foreground",
          className,
        )}
        data-testid={testId ?? "rights-not-recorded"}
      >
        <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
        Rights not recorded
      </span>
    );
  }
  return (
    <span className={cn("inline-flex flex-wrap gap-1", className)} data-testid={testId ?? "rights-recorded"}>
      {rights.tags.map((t) => (
        <span
          key={t.id}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
            tone === "dark" ? "border-white/25 bg-white/15 text-white" : "border-primary/30 bg-primary/10 text-primary",
          )}
        >
          <Check className="h-3 w-3 shrink-0" aria-hidden />
          {t.name}
        </span>
      ))}
    </span>
  );
}

/**
 * The "Usage rights" section for photo details and the lightbox. Always shown:
 * a warning with a route to review when nothing is recorded, otherwise the
 * recorded tags with the disclaimer. Rights are set per album, so "review"
 * goes to the photo's album.
 */
export function UsageRightsSection({
  rights,
  albumId,
  tone = "default",
  pillsTestId,
  pillTestIdPrefix,
}: {
  rights: UsageRightsValue;
  albumId?: number | null;
  tone?: "default" | "dark";
  /** Kept from the old attribution panels so browser tests still find them. */
  pillsTestId?: string;
  pillTestIdPrefix?: string;
}) {
  const dark = tone === "dark";
  return (
    <section className="space-y-2" aria-labelledby="usage-rights-heading" data-testid="usage-rights-section" data-rights-status={rights.status}>
      <p
        id="usage-rights-heading"
        role="heading"
        aria-level={3}
        className={cn("flex items-center gap-1.5 text-sm font-medium", dark ? "text-xs font-semibold uppercase tracking-wide text-white/70" : "text-muted-foreground")}
      >
        <Copyright className="h-3.5 w-3.5" aria-hidden />
        Usage rights
      </p>
      {rights.status === "not_recorded" ? (
        <div
          className={cn(
            "rounded-lg border px-3 py-2",
            dark ? "border-warning/40 bg-warning/10" : "border-warning/40 bg-warning/10",
          )}
          role="status"
          data-testid="rights-not-recorded-notice"
        >
          <p className={cn("flex items-center gap-1.5 text-sm font-semibold", dark ? "text-amber-200" : "text-warning-foreground")}>
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            Rights not recorded
          </p>
          <p className={cn("mt-0.5 text-xs", dark ? "text-amber-100/80" : "text-warning-foreground")}>
            No usage rights are recorded for this photo. Check before using it.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5" data-testid={pillsTestId}>
            {rights.tags.map((tag) => (
              <span
                key={tag.id}
                className={cn(
                  "flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium",
                  dark ? "border-white/25 bg-white/15 text-white" : "border-primary/30 bg-primary/10 text-primary",
                )}
                data-testid={pillTestIdPrefix ? `${pillTestIdPrefix}${tag.id}` : undefined}
              >
                <Check className="h-3 w-3 shrink-0" aria-hidden />
                {tag.name}
              </span>
            ))}
          </div>
          <p className={cn("text-[11px]", dark ? "text-white/50" : "text-muted-foreground")}>{RIGHTS_DISCLAIMER}</p>
        </>
      )}
      {albumId != null && (
        <Link
          href={`/albums/${albumId}`}
          className={cn("inline-block text-xs font-medium underline-offset-2 hover:underline", dark ? "text-sky-300" : "text-primary")}
          data-testid="review-rights-link"
        >
          {rights.status === "not_recorded" ? "Review rights on the album →" : "Manage rights on the album →"}
        </Link>
      )}
    </section>
  );
}

/**
 * Selection-bar note (#207): how many selected photos have no rights recorded.
 * Announced politely; renders nothing when every selected photo has rights.
 */
export function SelectionRightsSummary({
  photos,
}: {
  photos: { usageRights?: UsageRightsValue | null; attributionTags?: { id: number; name: string }[] | null }[];
}) {
  const unknown = photos.filter((p) => usageRightsOf(p).status === "not_recorded").length;
  return (
    <span role="status" className="text-sm" data-testid="selection-rights-summary">
      {unknown > 0 && (
        <span className="inline-flex items-center gap-1 text-warning-foreground">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          {unknown} with rights not recorded
        </span>
      )}
    </span>
  );
}
