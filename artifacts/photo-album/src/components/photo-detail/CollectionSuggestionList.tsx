import type { SuggestedCollection, SuggestedNewCollection } from "@workspace/api-client-react";
import { Sparkles, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

// The one renderer for AI collection recommendations (#212). Both the photo
// details page and the lightbox sidebar pass the API's pending list straight in,
// so the two surfaces can never disagree about candidates or reasons. Accepted,
// dismissed and manual states live on the server; this only shows what is pending.

type Tone = "light" | "dark";

function provenanceTitle(s: { reason: string | null; provider: string | null; model: string | null; analysisVersion: string | null }) {
  const by = s.provider ? `${s.provider}${s.model ? ` / ${s.model}` : ""}` : "AI analysis";
  return `${s.reason ?? "Recommended by AI analysis"} (${by}${s.analysisVersion ? `, ${s.analysisVersion}` : ""})`;
}

export function CollectionSuggestionList({
  suggestedCollections,
  suggestedNewCollections,
  tone = "light",
  disabled = false,
  onAccept,
  onDismiss,
  onCreateNew,
  onDismissNew,
}: {
  suggestedCollections?: SuggestedCollection[];
  suggestedNewCollections?: SuggestedNewCollection[];
  tone?: Tone;
  disabled?: boolean;
  onAccept: (collectionId: number) => void;
  onDismiss: (collectionId: number) => void;
  onCreateNew: (suggestion: { suggestionId: number; name: string }) => void;
  onDismissNew: (suggestionId: number) => void;
}) {
  const dark = tone === "dark";
  const existing = suggestedCollections ?? [];
  const fresh = suggestedNewCollections ?? [];
  if (existing.length === 0 && fresh.length === 0) return null;

  const heading = cn("text-[11px] uppercase tracking-wide", dark ? "text-white/60" : "text-muted-foreground");
  const dismissBtn = cn("rounded-full p-0.5 disabled:opacity-50", dark ? "text-white/60 hover:bg-white/15" : "text-muted-foreground hover:bg-muted-foreground/15");

  return (
    <div className="space-y-1.5 pt-1" data-testid="collection-suggestions">
      {existing.length > 0 && (
        <div className="space-y-1.5">
          <p className={heading}>AI recommended collections</p>
          <div className="flex flex-wrap gap-1.5" data-testid="suggested-collections">
            {existing.map((s) => (
              <div
                key={s.id}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border pl-2.5 pr-1 py-0.5 text-xs",
                  dark ? "border-warning/50 bg-warning/20 text-amber-100" : "border-primary/30 bg-rose-50 dark:bg-rose-950",
                )}
                title={provenanceTitle(s)}
                data-testid={`suggested-collection-${s.id}`}
              >
                <Sparkles className={cn("h-3 w-3", dark ? "text-amber-200" : "text-primary")} />
                <span className={dark ? undefined : "text-foreground"}>{s.title}</span>
                <button
                  type="button"
                  onClick={() => onAccept(s.id)}
                  disabled={disabled}
                  className={cn("rounded-full p-0.5 disabled:opacity-50", dark ? "text-amber-200 hover:bg-white/15" : "text-primary hover:bg-rose-100 dark:hover:bg-rose-900")}
                  aria-label={`Accept recommendation: add to ${s.title}`}
                  data-testid={`accept-suggestion-${s.id}`}
                >
                  <Check className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onDismiss(s.id)}
                  disabled={disabled}
                  className={dismissBtn}
                  aria-label={`Dismiss recommendation: ${s.title}`}
                  data-testid={`dismiss-suggestion-${s.id}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {fresh.length > 0 && (
        <div className="space-y-1.5">
          <p className={heading}>AI suggests a new collection</p>
          <div className="flex flex-wrap gap-1.5" data-testid="suggested-new-collections">
            {fresh.map((s) => (
              <div
                key={s.id}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border pl-2.5 pr-1 py-0.5 text-xs",
                  dark ? "border-success/50 bg-success/20 text-emerald-100" : "border-success/40 bg-success/15",
                )}
                title={provenanceTitle(s)}
                data-testid={`suggested-new-collection-${s.id}`}
              >
                <Sparkles className={cn("h-3 w-3", dark ? "text-emerald-200" : "text-success-foreground")} />
                <span className={dark ? undefined : "text-foreground"}>{s.suggestedName}</span>
                <button
                  type="button"
                  onClick={() => onCreateNew({ suggestionId: s.id, name: s.suggestedName })}
                  disabled={disabled}
                  className={cn("rounded-full p-0.5 disabled:opacity-50", dark ? "text-emerald-200 hover:bg-white/15" : "text-success-foreground hover:bg-success/25")}
                  aria-label={`Create collection "${s.suggestedName}" and add photo`}
                  title="Create this collection and add photo"
                  data-testid={`accept-new-collection-suggestion-${s.id}`}
                >
                  <Check className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onDismissNew(s.id)}
                  disabled={disabled}
                  className={dismissBtn}
                  aria-label={`Dismiss new collection suggestion: ${s.suggestedName}`}
                  data-testid={`dismiss-new-collection-suggestion-${s.id}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
