import { useEffect, useRef, useState } from "react";
import { Link, useRoute, useLocation } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  useCampaign,
  useUpdateCampaign,
  useDeleteCampaign,
  useGenerateCampaignSuggestions,
  getGenerationLimit,
  useGenerationSession,
  generationDownloadUrl,
  getCampaignBriefConflict,
  isCampaignRequestUnanswered,
  getGenerationSessionQueryKey,
  type ImageGenerationResult,
  type GenerateCampaignSuggestionsResult,
  type RequiredInput,
  type RequiredInputRole,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getActiveOrgId } from "@/lib/active-org";
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
import { useCapabilities } from "@/hooks/useCapabilities";

// Campaign detail (#192): the brief on top (editable), suggested results below,
// and a "Generate 3" that produces three distinct ad concepts on the spot.

// A concept the server did not render because a required photo/logo couldn't
// be found (#215). `resume` is what the server returned so the person can
// continue it without the input; it isn't part of the shared client type.
interface HeldConcept {
  title: string;
  missing: RequiredInput[];
  resume: unknown;
}

function heldFrom(result: GenerateCampaignSuggestionsResult): HeldConcept[] {
  return result.concepts
    .filter((c) => c.status === "needs_input" && c.missing && c.missing.length > 0)
    .map((c) => ({ title: c.title, missing: c.missing!, resume: (c as { resume?: unknown }).resume }));
}

const NEED_WORDS: Record<RequiredInputRole, { noun: string; choose: string; href: string }> = {
  hero_photo: { noun: "photo", choose: "Choose a photo…", href: "/photos" },
  exact_asset: { noun: "logo", choose: "Choose a logo…", href: "/assets" },
};

function NeedsInputCard({
  concept,
  canManage,
  busy,
  onGenerateWithout,
}: {
  concept: HeldConcept;
  canManage: boolean;
  busy: boolean;
  onGenerateWithout: () => void;
}) {
  const nouns = concept.missing.map((m) => NEED_WORDS[m.role].noun);
  const id = `needs-input-${concept.title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div
      role="group"
      aria-labelledby={id}
      className="flex flex-col gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3"
      data-testid="needs-input-concept"
    >
      {/* role=heading, not <h*>: global h1–h6 !important colours would override the amber. */}
      <div id={id} role="heading" aria-level={3} className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <span className="min-w-0 truncate">{concept.title}</span>
      </div>
      <p className="text-xs font-medium text-foreground">Needs a {nouns.join(" and a ")}</p>
      {concept.missing.map((m) => (
        <p key={m.role} className="text-xs text-muted-foreground">
          {m.message}
        </p>
      ))}
      <div className="mt-auto flex flex-wrap gap-2 pt-1">
        {concept.missing.map((m) => (
          <Link
            key={m.role}
            href={NEED_WORDS[m.role].href}
            className="inline-flex h-7 items-center rounded-md border border-input bg-background px-3 text-xs hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            data-testid={`needs-input-choose-${m.role}`}
          >
            {NEED_WORDS[m.role].choose}
          </Link>
        ))}
        {canManage && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            disabled={busy || !concept.resume}
            onClick={onGenerateWithout}
            data-testid="needs-input-generate-without"
          >
            Generate without a {nouns.join(" or a ")}
          </Button>
        )}
      </div>
    </div>
  );
}

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
  const caps = useCapabilities();
  // Only its creator or an org owner/admin can change a campaign (#218).
  const canManage = campaign != null && caps.canManageItem(campaign.createdById);
  const { mutate: update, isPending: saving } = useUpdateCampaign();
  const { mutate: remove, isPending: deleting } = useDeleteCampaign();
  const generate = useGenerateCampaignSuggestions();
  const session = useGenerationSession(campaign?.sessionId ?? undefined);
  const queryClient = useQueryClient();
  // Concepts held back for a missing photo/logo (#215), shown until continued.
  const [held, setHeld] = useState<HeldConcept[]>([]);
  const [continuing, setContinuing] = useState<string | null>(null);

  // The draft in the editor, and the server brief/revision it was based on
  // (#216). The draft only follows the server while it has no unsaved edits, so
  // a refetch (e.g. after another tab saves) never wipes what the user typed.
  const [brief, setBrief] = useState("");
  const [base, setBase] = useState<{ id: number; brief: string; revision: number } | null>(null);
  const draftEdited = base != null && brief.trim() !== base.brief;
  useEffect(() => {
    if (!campaign) return;
    const serverHasDraft = campaign.brief === brief.trim();
    if (base == null || base.id !== campaign.id || !draftEdited) {
      setBrief(campaign.brief);
      setBase({ id: campaign.id, brief: campaign.brief, revision: campaign.briefRevision });
    } else if (serverHasDraft) {
      // The server already holds exactly this draft (e.g. generate saved it and
      // then failed): that's our own save, not a change from elsewhere.
      setBase({ id: campaign.id, brief: campaign.brief, revision: campaign.briefRevision });
    }
    // Otherwise keep the edits; the banner below offers the newer version.
  }, [campaign?.id, campaign?.brief, campaign?.briefRevision]);

  // A generate request that got no HTTP answer is retried with the same id, so
  // the server can recognise it and not start the work twice.
  const unansweredRequest = useRef<{ requestId: string; brief: string; revision: number } | null>(null);
  const [starting, setStarting] = useState(false);
  // Synchronous double-click guard (state updates land after the handler).
  const inFlight = useRef(false);

  const briefDirty = campaign != null && brief.trim() !== campaign.brief;
  const changedElsewhere = campaign != null && base != null && draftEdited && campaign.briefRevision !== base.revision;
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

  function handleConflict(err: unknown): boolean {
    const conflict = getCampaignBriefConflict(err);
    if (!conflict) return false;
    toast({ title: "Brief changed elsewhere", description: conflict.error, variant: "destructive" });
    return true;
  }

  function handleSave() {
    if (!campaign || !base || saving || starting) return;
    const text = brief.trim();
    update(
      { id: campaign.id, brief: text, expectedRevision: base.revision },
      {
        onSuccess: (saved) => setBase({ id: saved.id, brief: saved.brief, revision: saved.briefRevision }),
        onError: (err) => {
          if (!handleConflict(err)) toast({ title: "Failed to save brief", variant: "destructive" });
        },
      },
    );
  }

  // Save-and-generate is ONE request (#216): the server saves this exact brief
  // (refusing if another tab changed it) and only then starts generation, so
  // the suggestions always come from what's on screen. On any failure the
  // draft stays in the editor.
  function handleGenerate() {
    if (campaignId == null || !base || inFlight.current || starting || generate.isPending || anyPending || saving) return;
    const text = brief.trim();
    const pending = unansweredRequest.current;
    const request = pending && pending.brief === text && pending.revision === base.revision
      ? pending
      : { requestId: crypto.randomUUID(), brief: text, revision: base.revision };
    inFlight.current = true;
    setStarting(true);
    generate.mutate(
      { id: campaignId, brief: request.brief, expectedRevision: request.revision, requestId: request.requestId },
      {
        onSuccess: (result) => {
          unansweredRequest.current = null;
          setBase({ id: campaignId, brief: result.brief, revision: result.briefRevision });
          if (result.duplicate) toast({ title: "Already generating these suggestions" });
          else setHeld(heldFrom(result));
          for (const notice of result.notices ?? []) toast({ title: "Heads up", description: notice });
        },
        onError: (err) => {
          unansweredRequest.current = isCampaignRequestUnanswered(err) ? request : null;
          if (handleConflict(err)) return;
          const limit = getGenerationLimit(err);
          if (limit) {
            toast({ title: "Image generation is busy", description: limit.message, variant: "destructive" });
            return;
          }
          toast({
            title: "Suggestion generation failed",
            description: err instanceof Error ? err.message : undefined,
            variant: "destructive",
          });
        },
        onSettled: () => {
          inFlight.current = false;
          setStarting(false);
        },
      },
    );
  }

  // "Generate without": continue one held concept with every missing role
  // acknowledged. The server re-checks and records the acknowledgement.
  async function handleGenerateWithout(concept: HeldConcept) {
    if (!campaign || continuing) return;
    setContinuing(concept.title);
    try {
      const orgId = getActiveOrgId();
      const res = await fetch(`/api/campaigns/${campaign.id}/generate-concept`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(orgId != null ? { "x-organization-id": String(orgId) } : {}) },
        body: JSON.stringify({ concept: concept.resume, acknowledgedMissing: concept.missing.map((m) => m.role) }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        toast({ title: "Suggestion generation failed", description: data?.error, variant: "destructive" });
        return;
      }
      const result = (await res.json()) as GenerateCampaignSuggestionsResult;
      setHeld((prev) => [...prev.filter((h) => h.title !== concept.title), ...heldFrom(result)]);
      queryClient.invalidateQueries({ queryKey: getGenerationSessionQueryKey(result.sessionId ?? undefined) });
      queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    } catch {
      toast({ title: "Suggestion generation failed", variant: "destructive" });
    } finally {
      setContinuing(null);
    }
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
          {canManage && (
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
          )}
        </div>

        {/* The brief — the instructions the agent works from. */}
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Brief</p>
          <Textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            readOnly={!canManage}
            className="min-h-[140px] text-sm"
            data-testid="campaign-brief-editor"
          />
          {!canManage && (
            <p className="text-xs text-muted-foreground" data-testid="campaign-read-only">
              Only the person who created this campaign or an organization owner/admin can change it.
            </p>
          )}
          {changedElsewhere && (
            <div
              className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
              role="status"
              data-testid="brief-changed-elsewhere"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
              <span className="min-w-0 flex-1">
                This brief was changed elsewhere since you started editing. Your edits are kept here.
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => {
                  setBrief(campaign.brief);
                  setBase({ id: campaign.id, brief: campaign.brief, revision: campaign.briefRevision });
                }}
                data-testid="brief-load-latest-btn"
              >
                Load latest
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => setBase({ id: campaign.id, brief: campaign.brief, revision: campaign.briefRevision })}
                data-testid="brief-keep-mine-btn"
              >
                Keep my edits
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {briefDirty && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={!canManage || saving || starting || !brief.trim() || changedElsewhere}
                onClick={handleSave}
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
              disabled={!canManage || starting || generate.isPending || anyPending || saving || !brief.trim() || changedElsewhere}
              data-testid="generate-suggestions-btn"
            >
              {starting || generate.isPending || anyPending ? (
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
          {held.length > 0 && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="needs-input-concepts">
              {held.map((h) => (
                <NeedsInputCard
                  key={h.title}
                  concept={h}
                  canManage={canManage}
                  busy={continuing != null}
                  onGenerateWithout={() => handleGenerateWithout(h)}
                />
              ))}
            </div>
          )}
          {suggestions.length === 0 && held.length === 0 && !generate.isPending ? (
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
