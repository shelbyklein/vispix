import { useEffect, useState } from "react";
import { Link, useRoute, useLocation } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  useCampaign,
  useUpdateCampaign,
  useDeleteCampaign,
  useGenerateCampaignSuggestions,
  useGenerationSession,
  generationDownloadUrl,
  type ImageGenerationResult,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Megaphone, Loader2, Sparkles, Download, Trash2, AlertTriangle, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Campaign detail (#192): the brief on top (editable), suggested results below,
// and a "Generate 3" that produces three distinct ad concepts on the spot.

function SuggestionCard({ generation }: { generation: ImageGenerationResult }) {
  // Concept prompts are stored as "Title: full instruction".
  const title = generation.prompt.split(":")[0]?.slice(0, 80) ?? "Suggestion";
  if (generation.status === "pending") {
    return (
      <div className="flex aspect-square flex-col items-center justify-center gap-2 rounded-lg border border-border bg-muted/30 p-3 text-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-xs text-muted-foreground">Generating… up to a minute</p>
      </div>
    );
  }
  if (generation.status === "failed") {
    return (
      <div className="flex aspect-square flex-col items-center justify-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-center">
        <AlertTriangle className="h-5 w-5 text-destructive" />
        <p className="text-xs text-destructive">{generation.error ?? "Generation failed"}</p>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted/20" data-testid={`suggestion-${generation.id}`}>
      {generation.imageUrl && (
        <img src={generation.imageUrl} alt={title} className="w-full object-contain" loading="lazy" />
      )}
      <div className="flex items-center justify-between gap-2 border-t border-border/60 px-2.5 py-1.5">
        <span className="min-w-0 truncate text-xs font-medium text-foreground" title={generation.prompt}>
          {title}
        </span>
        <div className="flex shrink-0 gap-1">
          <a href={generationDownloadUrl(generation.id, "png")} download>
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs">
              <Download className="h-3 w-3" /> PNG
            </Button>
          </a>
          <a href={generationDownloadUrl(generation.id, "jpg")} download>
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs">
              <Download className="h-3 w-3" /> JPG
            </Button>
          </a>
        </div>
      </div>
    </div>
  );
}

export default function CampaignDetailPage() {
  const { toast } = useToast();
  const [, params] = useRoute("/campaigns/:id");
  const [, setLocation] = useLocation();
  const campaignId = params?.id ? parseInt(params.id, 10) : undefined;

  const { data: campaign, isLoading } = useCampaign(campaignId);
  const { mutate: update, isPending: saving } = useUpdateCampaign();
  const { mutate: remove, isPending: deleting } = useDeleteCampaign();
  const generate = useGenerateCampaignSuggestions();
  const session = useGenerationSession(campaign?.sessionId ?? undefined);

  const [brief, setBrief] = useState("");
  useEffect(() => {
    if (campaign) setBrief(campaign.brief);
  }, [campaign?.id, campaign?.brief]);

  const briefDirty = campaign != null && brief.trim() !== campaign.brief;
  const suggestions = [...(session.data?.generations ?? [])].reverse();
  const anyPending = suggestions.some((g) => g.status === "pending");

  if (isLoading || !campaign) {
    return (
      <AppLayout>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading campaign…
        </div>
      </AppLayout>
    );
  }

  function handleGenerate() {
    if (campaignId == null || generate.isPending || anyPending) return;
    // Save an edited brief first so the agent works from what's on screen.
    if (briefDirty) {
      update({ id: campaignId, brief: brief.trim() });
    }
    generate.mutate(campaignId, {
      onError: (err) =>
        toast({
          title: "Suggestion generation failed",
          description: err instanceof Error ? err.message : undefined,
          variant: "destructive",
        }),
    });
  }

  return (
    <AppLayout>
      <div className="mx-auto max-w-4xl space-y-6" data-testid="campaign-detail-page">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link href="/campaigns" className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-3 w-3" /> Campaigns
            </Link>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
              <Megaphone className="h-6 w-6 shrink-0 text-primary" />
              <span className="min-w-0 truncate">{campaign.name}</span>
            </h1>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon" title="Delete campaign" data-testid="delete-campaign-btn">
                <Trash2 className="h-4 w-4 text-muted-foreground" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this campaign?</AlertDialogTitle>
                <AlertDialogDescription>
                  "{campaign.name}" will be deleted. Already-generated suggestions stay available in Create's session
                  list.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={deleting}
                  className="bg-destructive hover:bg-destructive/90"
                  onClick={() =>
                    remove(campaign.id, {
                      onSuccess: () => setLocation("/campaigns"),
                      onError: () => toast({ title: "Failed to delete campaign", variant: "destructive" }),
                    })
                  }
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        {/* The brief — the instructions the agent works from. */}
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Brief</p>
          <Textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            className="min-h-[140px] text-sm"
            data-testid="campaign-brief-editor"
          />
          <div className="flex flex-wrap items-center gap-2">
            {briefDirty && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={saving || !brief.trim()}
                onClick={() =>
                  update(
                    { id: campaign.id, brief: brief.trim() },
                    { onError: () => toast({ title: "Failed to save brief", variant: "destructive" }) },
                  )
                }
                data-testid="save-brief-btn"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save brief
              </Button>
            )}
            <Button
              size="sm"
              className="gap-1.5"
              onClick={handleGenerate}
              disabled={generate.isPending || anyPending || !brief.trim()}
              data-testid="generate-suggestions-btn"
            >
              {generate.isPending || anyPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              Generate 3 suggestions
            </Button>
            <span className="text-[11px] text-muted-foreground/70">
              Three distinct concepts, grounded in your library's photos and logo.
            </span>
          </div>
        </div>

        {/* Suggested results */}
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Suggested results</p>
          {suggestions.length === 0 && !generate.isPending ? (
            <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
              No suggestions yet — hit "Generate 3 suggestions".
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {suggestions.map((g) => (
                <SuggestionCard key={g.id} generation={g} />
              ))}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
