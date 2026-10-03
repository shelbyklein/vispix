import type { SuggestedCollection, SuggestedNewCollection } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Sparkles, Loader2, RefreshCw, Pencil } from "lucide-react";
import { CollectionSuggestionList } from "./CollectionSuggestionList";

export function AiDescriptionPanel({
  aiDescription,
  createdAt,
  suggestedCollections,
  suggestedNewCollections,
  canEditDescription,
  canRerunAnalysis,
  editingDescription,
  descriptionDraft,
  setDescriptionDraft,
  savingDescription,
  rerunning,
  onStartEdit,
  onCancelEdit,
  onSave,
  onRerun,
  onAcceptSuggestion,
  onDismissSuggestion,
  onCreateNewCollection,
  onDismissNewCollectionSuggestion,
}: {
  aiDescription?: string | null;
  createdAt: string;
  suggestedCollections?: SuggestedCollection[];
  suggestedNewCollections?: SuggestedNewCollection[];
  canEditDescription: boolean;
  canRerunAnalysis: boolean;
  editingDescription: boolean;
  descriptionDraft: string;
  setDescriptionDraft: (value: string) => void;
  savingDescription: boolean;
  rerunning: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onRerun: () => void;
  onAcceptSuggestion: (collectionId: number) => void;
  onDismissSuggestion: (collectionId: number) => void;
  onCreateNewCollection: (suggestion: { suggestionId: number; name: string }) => void;
  onDismissNewCollectionSuggestion: (suggestionId: number) => void;
}) {
  return (
    <div
      className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 space-y-2"
      data-testid="ai-description-block"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5" />
          AI description
        </div>
        <div className="flex items-center gap-2">
          {canEditDescription && !editingDescription && (
            <button
              type="button"
              onClick={onStartEdit}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
              data-testid="edit-description-btn"
              title="Edit description"
            >
              <Pencil className="h-3 w-3" />
              Edit
            </button>
          )}
          {canRerunAnalysis && !editingDescription && (
            <button
              type="button"
              onClick={onRerun}
              disabled={rerunning}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              data-testid="rerun-analysis-btn"
              title="Re-run AI analysis"
            >
              {rerunning ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              Regenerate
            </button>
          )}
        </div>
      </div>
      {editingDescription ? (
        <div className="space-y-2" data-testid="description-edit-form">
          <Textarea
            value={descriptionDraft}
            onChange={(e) => setDescriptionDraft(e.target.value)}
            placeholder="Enter a description…"
            className="text-sm min-h-[80px] resize-none"
            disabled={savingDescription}
            autoFocus
            data-testid="description-textarea"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-7 text-xs px-3"
              onClick={onSave}
              disabled={savingDescription}
              data-testid="save-description-btn"
            >
              {savingDescription ? (
                <><Loader2 className="h-3 w-3 animate-spin mr-1" />Saving…</>
              ) : (
                "Save"
              )}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs px-3"
              onClick={onCancelEdit}
              disabled={savingDescription}
              data-testid="cancel-description-btn"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : aiDescription ? (
        <p className="text-sm text-foreground" data-testid="ai-description-text">
          {aiDescription}
        </p>
      ) : createdAt && Date.now() - new Date(createdAt).getTime() < 60_000 ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="ai-description-loading">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Analyzing photo…
        </div>
      ) : (
        <p className="text-xs text-muted-foreground/70 italic">No description available.</p>
      )}
      <CollectionSuggestionList
        suggestedCollections={suggestedCollections}
        suggestedNewCollections={suggestedNewCollections}
        onAccept={onAcceptSuggestion}
        onDismiss={onDismissSuggestion}
        onCreateNew={onCreateNewCollection}
        onDismissNew={onDismissNewCollectionSuggestion}
      />
    </div>
  );
}
