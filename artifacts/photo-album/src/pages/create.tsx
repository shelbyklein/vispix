import { useEffect, useRef, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  useGenerateImages,
  useGenerationSessions,
  useGenerationSession,
  usePlanGeneration,
  generationDownloadUrl,
  useSearchPhotos,
  getSearchPhotosQueryKey,
  useListAssets,
  getListAssetsQueryKey,
  type GenerationRequestInput,
  type GenerationInputRole,
  type GenerationFormatId,
  type ImageGenerationResult,
  type GenerationPlan,
  type PlanCandidate,
} from "@workspace/api-client-react";
import { useUpload } from "@workspace/object-storage-web";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Sparkles,
  Upload,
  Images,
  X,
  Loader2,
  Download,
  Wand2,
  Plus,
  AlertTriangle,
  Search,
  MessageCircleQuestion,
  Check,
  Lightbulb,
  SendHorizonal,
  Settings2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// The Create workspace (#167): a chat between the user and a planning
// assistant. Every submit is a chat message — the assistant replies with a
// plan (summary, clarifying questions, candidate images from the library);
// the user keeps replying to refine, and generates from the assistant's card
// when ready. The back-and-forth stays in the transcript; once an image
// generation lands, that turn is summarized by its prompt + variants (from the
// server session) and a fresh exchange can begin.

const FORMATS: { id: GenerationFormatId; label: string }[] = [
  { id: "1:1", label: "Square 1:1" },
  { id: "4:5", label: "Social 4:5" },
  { id: "9:16", label: "Story 9:16" },
  { id: "letter", label: "US Letter" },
];

const ROLE_LABELS: Record<GenerationInputRole, string> = {
  style: "Style ref",
  hero_photo: "Hero photo",
  exact_asset: "Exact asset",
};

interface AttachedInput extends GenerationRequestInput {
  localId: string;
  previewUrl: string | null;
}

type ChatTurn =
  | { id: string; type: "user"; text: string }
  | { id: string; type: "plan"; plan: GenerationPlan };

function VispixPickerDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (input: Omit<AttachedInput, "localId">) => void;
}) {
  const [photoQuery, setPhotoQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const photoParams = { q: submittedQuery, limit: 24, offset: 0 };
  const photos = useSearchPhotos(photoParams, {
    query: { enabled: open && !!submittedQuery, queryKey: getSearchPhotosQueryKey(photoParams) },
  });
  const assets = useListAssets(undefined, {
    query: { enabled: open, queryKey: getListAssetsQueryKey() },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add from Vispix</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="photos">
          <TabsList>
            <TabsTrigger value="photos">Photos</TabsTrigger>
            <TabsTrigger value="assets">Brand assets</TabsTrigger>
          </TabsList>
          <TabsContent value="photos" className="space-y-3">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setSubmittedQuery(photoQuery.trim());
              }}
            >
              <Input
                value={photoQuery}
                onChange={(e) => setPhotoQuery(e.target.value)}
                placeholder="Search photos…"
                data-testid="picker-photo-search"
              />
              <Button type="submit" variant="secondary" size="sm" className="h-9">
                <Search className="h-4 w-4" />
              </Button>
            </form>
            {photos.isFetching ? (
              <div className="flex items-center gap-1.5 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Searching…
              </div>
            ) : (
              <div className="grid max-h-80 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6">
                {(photos.data?.photos ?? []).map((p) => {
                  const thumb = p.thumbnailKey ? `/api/storage${p.thumbnailKey}` : p.url;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className="aspect-square overflow-hidden rounded-md border border-border hover:ring-2 hover:ring-primary"
                      onClick={() => {
                        onPick({
                          kind: "photo",
                          refId: p.id,
                          role: "hero_photo",
                          name: p.filename ?? `photo-${p.id}`,
                          previewUrl: thumb,
                        });
                        onOpenChange(false);
                      }}
                      data-testid={`picker-photo-${p.id}`}
                    >
                      <img src={thumb} alt={p.filename ?? `Photo ${p.id}`} className="h-full w-full object-cover" loading="lazy" />
                    </button>
                  );
                })}
                {submittedQuery && !photos.isFetching && (photos.data?.photos ?? []).length === 0 && (
                  <p className="col-span-full py-4 text-sm text-muted-foreground">No photos matched.</p>
                )}
              </div>
            )}
          </TabsContent>
          <TabsContent value="assets">
            <div className="grid max-h-80 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6">
              {(assets.data ?? [])
                .filter((a) => a.contentType?.startsWith("image/"))
                .map((a) => {
                  const url = `/api/storage${a.storageKey}`;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      title={a.name}
                      className="aspect-square overflow-hidden rounded-md border border-border bg-muted/40 p-1 hover:ring-2 hover:ring-primary"
                      onClick={() => {
                        onPick({
                          kind: "asset",
                          refId: a.id,
                          role: a.kind === "brand" ? "exact_asset" : "style",
                          name: a.name,
                          previewUrl: url,
                        });
                        onOpenChange(false);
                      }}
                      data-testid={`picker-asset-${a.id}`}
                    >
                      <img src={url} alt={a.name} className="h-full w-full object-contain" loading="lazy" />
                    </button>
                  );
                })}
              {(assets.data ?? []).filter((a) => a.contentType?.startsWith("image/")).length === 0 && (
                <p className="col-span-full py-4 text-sm text-muted-foreground">No image assets in the library yet.</p>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function PlanCard({
  plan,
  isLatest,
  isAttached,
  onToggleCandidate,
  onApplyFormat,
  formatApplied,
  onGenerate,
  generating,
  variantCount,
}: {
  plan: GenerationPlan;
  isLatest: boolean;
  isAttached: (c: PlanCandidate) => boolean;
  onToggleCandidate: (c: PlanCandidate) => void;
  onApplyFormat: (f: GenerationFormatId) => void;
  formatApplied: boolean;
  onGenerate: () => void;
  generating: boolean;
  variantCount: number;
}) {
  return (
    <div className="mr-auto w-full max-w-[95%] space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3" data-testid="plan-card">
      <div className="flex items-start gap-2 text-sm text-foreground">
        <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p>{plan.summary}</p>
      </div>
      {plan.questions.length > 0 && (
        <div className="space-y-1 text-sm">
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <MessageCircleQuestion className="h-3.5 w-3.5" /> A few questions — reply below:
          </p>
          <ul className="list-disc space-y-0.5 pl-6 text-foreground">
            {plan.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      )}
      {plan.slots.map((slot) => (
        <div key={slot.slot} className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            {slot.slot} — suggested from your library (searched “{slot.query}”). Click to attach:
          </p>
          {slot.items.length === 0 ? (
            <p className="text-xs italic text-muted-foreground/70">No matches in your library.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {slot.items.map((c) => {
                const attached = isAttached(c);
                return (
                  <button
                    key={`${c.kind}-${c.refId}`}
                    type="button"
                    title={c.name}
                    onClick={() => onToggleCandidate(c)}
                    className={cn(
                      "relative aspect-square overflow-hidden rounded-md border",
                      attached ? "border-primary ring-2 ring-primary" : "border-border hover:ring-2 hover:ring-primary/50",
                    )}
                    data-testid={`plan-candidate-${c.kind}-${c.refId}`}
                  >
                    <img src={c.previewUrl} alt={c.name} className="h-full w-full object-cover" loading="lazy" />
                    {attached && (
                      <span className="absolute right-1 top-1 rounded-full bg-primary p-0.5">
                        <Check className="h-3 w-3 text-primary-foreground" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {plan.suggestedFormat && (
          <button
            type="button"
            onClick={() => onApplyFormat(plan.suggestedFormat!)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs",
              formatApplied
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:border-primary/50",
            )}
            data-testid="plan-format-suggestion"
          >
            {formatApplied && <Check className="h-3 w-3" />}
            Format: {FORMATS.find((f) => f.id === plan.suggestedFormat)?.label ?? plan.suggestedFormat}
          </button>
        )}
        {isLatest && (
          <Button
            type="button"
            size="sm"
            className="ml-auto gap-1.5"
            onClick={onGenerate}
            disabled={generating}
            data-testid="plan-generate-btn"
          >
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Generate {variantCount} variant{variantCount !== 1 ? "s" : ""}
          </Button>
        )}
      </div>
    </div>
  );
}

function GenerationCard({
  generation,
  onRevise,
  revising,
}: {
  generation: ImageGenerationResult;
  onRevise: (g: ImageGenerationResult) => void;
  revising: boolean;
}) {
  if (generation.status === "failed") {
    return (
      <div className="flex aspect-square flex-col items-center justify-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-center">
        <AlertTriangle className="h-5 w-5 text-destructive" />
        <p className="text-xs text-destructive">{generation.error ?? "Generation failed"}</p>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-lg border bg-muted/30",
        revising ? "border-primary ring-2 ring-primary" : "border-border",
      )}
      data-testid={`generation-${generation.id}`}
    >
      {generation.imageUrl && (
        <img src={generation.imageUrl} alt={generation.prompt} className="w-full object-contain" loading="lazy" />
      )}
      {/* Always-visible actions (hover overlays don't exist on touch screens). */}
      <div className="flex items-center justify-between gap-1 border-t border-border/60 bg-background/60 px-1.5 py-1">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 text-xs"
          onClick={() => onRevise(generation)}
          data-testid={`revise-${generation.id}`}
        >
          <Wand2 className="h-3 w-3" /> {revising ? "Revising" : "Revise"}
        </Button>
        <div className="flex gap-1">
          <a href={generationDownloadUrl(generation.id, "png")} download data-testid={`download-png-${generation.id}`}>
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs">
              <Download className="h-3 w-3" /> PNG
            </Button>
          </a>
          <a href={generationDownloadUrl(generation.id, "jpg")} download data-testid={`download-jpg-${generation.id}`}>
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs">
              <Download className="h-3 w-3" /> JPG
            </Button>
          </a>
        </div>
      </div>
    </div>
  );
}

export default function CreatePage() {
  const { toast } = useToast();
  const [sessionId, setSessionId] = useState<number | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [format, setFormat] = useState<GenerationFormatId>("1:1");
  const [variantCount, setVariantCount] = useState(1);
  const [attached, setAttached] = useState<AttachedInput[]>([]);
  const [reviseTarget, setReviseTarget] = useState<ImageGenerationResult | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // The current exchange's transcript (user messages + assistant plans). When a
  // generation lands, the exchange is captured by the generation's prompt +
  // variants from the server, and the local transcript resets for the next one.
  const [chatLog, setChatLog] = useState<ChatTurn[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const sessions = useGenerationSessions();
  const session = useGenerationSession(sessionId);
  const generate = useGenerateImages();
  const planner = usePlanGeneration();
  const { uploadFile, isUploading } = useUpload();

  const generations = session.data?.generations ?? [];
  const latestPlanId = [...chatLog].reverse().find((t) => t.type === "plan")?.id ?? null;
  // The full request so far: every user message this exchange, in order.
  const conversationText = (extra?: string) =>
    [...chatLog.filter((t): t is Extract<ChatTurn, { type: "user" }> => t.type === "user").map((t) => t.text), ...(extra ? [extra] : [])]
      .join("\n")
      .trim();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [generations.length, chatLog.length, generate.isPending, planner.isPending]);

  function resetExchange() {
    setChatLog([]);
    setDraft("");
    setAttached([]);
    setReviseTarget(null);
  }

  function candidateAttached(c: PlanCandidate): boolean {
    return attached.some((a) => a.kind === c.kind && a.refId === c.refId);
  }

  function toggleCandidate(c: PlanCandidate) {
    setAttached((prev) => {
      const existing = prev.find((a) => a.kind === c.kind && a.refId === c.refId);
      if (existing) return prev.filter((a) => a !== existing);
      return [
        ...prev,
        { localId: crypto.randomUUID(), kind: c.kind, refId: c.refId, role: c.role, name: c.name, previewUrl: c.previewUrl },
      ];
    });
  }

  async function handleUploadReference(file: File) {
    const uploaded = await uploadFile(file);
    if (!uploaded) {
      toast({ title: "Reference upload failed", variant: "destructive" });
      return;
    }
    setAttached((prev) => [
      ...prev,
      {
        localId: crypto.randomUUID(),
        kind: "upload",
        storageKey: uploaded.objectPath,
        role: "style",
        name: file.name,
        previewUrl: `/api/storage${uploaded.objectPath}`,
      },
    ]);
  }

  // Send = one chat message. Revising → generate the revision directly;
  // otherwise the assistant replies with a (re-)plan built from the whole
  // conversation so far.
  function handleSend() {
    const text = draft.trim();
    if (!text || planner.isPending || generate.isPending) return;

    if (reviseTarget) {
      runGenerate(text, reviseTarget.id);
      return;
    }

    setChatLog((prev) => [...prev, { id: crypto.randomUUID(), type: "user", text }]);
    setDraft("");
    planner.mutate(
      { prompt: conversationText(text), attachedNames: attached.map((a) => a.name ?? "attachment") },
      {
        onSuccess: (plan) => {
          setChatLog((prev) => [...prev, { id: crypto.randomUUID(), type: "plan", plan }]);
          if (plan.suggestedFormat) setFormat(plan.suggestedFormat);
        },
        onError: (err) => {
          toast({
            title: "Planning failed",
            description: err instanceof Error ? err.message : undefined,
            variant: "destructive",
          });
        },
      },
    );
  }

  function runGenerate(prompt: string, parentGenerationId?: number) {
    if (!prompt || generate.isPending) return;
    generate.mutate(
      {
        prompt,
        format,
        variantCount: parentGenerationId != null ? 1 : variantCount,
        sessionId,
        parentGenerationId,
        inputs:
          parentGenerationId != null
            ? []
            : attached.map(({ kind, refId, storageKey, role, name }) => ({ kind, refId, storageKey, role, name })),
      },
      {
        onSuccess: (result) => {
          setSessionId(result.sessionId);
          resetExchange();
          const failed = result.generations.filter((g) => g.status === "failed").length;
          if (failed > 0) {
            toast({
              title: failed === result.generations.length ? "Generation failed" : "Some variants failed",
              description: result.generations.find((g) => g.error)?.error ?? undefined,
              variant: "destructive",
            });
          }
        },
        onError: (err) => {
          toast({
            title: "Generation failed",
            description: err instanceof Error ? err.message : undefined,
            variant: "destructive",
          });
        },
      },
    );
  }

  // Generate from the plan card: includes any unsent draft text as a final
  // detail so an answer typed-but-not-sent still counts.
  function handleGenerateFromPlan() {
    const prompt = conversationText(draft.trim() || undefined);
    if (!prompt) return;
    runGenerate(prompt);
  }

  // Group the server's flat generation list into prompt turns.
  const groups: { prompt: string; items: ImageGenerationResult[] }[] = [];
  for (const g of generations) {
    const last = groups[groups.length - 1];
    if (
      last &&
      last.prompt === g.prompt &&
      last.items[0]?.parentGenerationId === g.parentGenerationId &&
      last.items[0]?.settings.variantCount === g.settings.variantCount
    ) {
      last.items.push(g);
    } else {
      groups.push({ prompt: g.prompt, items: [g] });
    }
  }

  return (
    <AppLayout>
      <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-4xl flex-col gap-4" data-testid="create-page">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
              <Sparkles className="h-6 w-6 text-primary" /> Create
            </h1>
            <p className="text-sm text-muted-foreground">
              Chat with the assistant to plan and generate marketing graphics from your library.
            </p>
          </div>
          <Select
            value={sessionId != null ? String(sessionId) : "__new__"}
            onValueChange={(v) => {
              resetExchange();
              setSessionId(v === "__new__" ? undefined : parseInt(v, 10));
            }}
          >
            <SelectTrigger className="h-8 w-52 text-xs" data-testid="session-picker">
              <SelectValue placeholder="New session" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__new__">
                <span className="flex items-center gap-1">
                  <Plus className="h-3 w-3" /> New session
                </span>
              </SelectItem>
              {(sessions.data ?? []).map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.title.slice(0, 40) || `Session ${s.id}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Chat transcript: past generations, then the current exchange. */}
        <div className="flex-1 space-y-4 overflow-y-auto rounded-lg border border-border bg-background/40 p-4">
          {groups.length === 0 && chatLog.length === 0 && !planner.isPending && !generate.isPending && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
              <Wand2 className="h-8 w-8" />
              <p className="max-w-sm text-sm">
                Describe the graphic you want. The assistant will suggest photos and logos from your library, ask
                what it needs to know, and generate when you're ready.
              </p>
              <p className="text-xs text-muted-foreground/70">
                Uses your organization's OpenAI key — configure it in Admin → AI settings.
              </p>
            </div>
          )}
          {groups.map((group, gi) => (
            <div key={gi} className="space-y-2">
              <div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary/10 px-3 py-2 text-sm text-foreground">
                {group.prompt}
              </div>
              <div
                className={cn(
                  "grid gap-3",
                  group.items.length === 1 ? "grid-cols-1 sm:max-w-md" : "grid-cols-1 sm:grid-cols-2",
                )}
              >
                {group.items.map((g) => (
                  <GenerationCard
                    key={g.id}
                    generation={g}
                    onRevise={(target) => setReviseTarget((prev) => (prev?.id === target.id ? null : target))}
                    revising={reviseTarget?.id === g.id}
                  />
                ))}
              </div>
            </div>
          ))}
          {chatLog.map((turn) =>
            turn.type === "user" ? (
              <div
                key={turn.id}
                className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary/10 px-3 py-2 text-sm text-foreground"
              >
                {turn.text}
              </div>
            ) : (
              <PlanCard
                key={turn.id}
                plan={turn.plan}
                isLatest={turn.id === latestPlanId}
                isAttached={candidateAttached}
                onToggleCandidate={toggleCandidate}
                onApplyFormat={setFormat}
                formatApplied={turn.plan.suggestedFormat != null && format === turn.plan.suggestedFormat}
                onGenerate={handleGenerateFromPlan}
                generating={generate.isPending}
                variantCount={variantCount}
              />
            ),
          )}
          {planner.isPending && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="plan-pending">
              <Loader2 className="h-4 w-4 animate-spin" />
              Thinking about what this graphic needs…
            </div>
          )}
          {generate.isPending && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="generation-pending">
              <Loader2 className="h-4 w-4 animate-spin" />
              Generating {reviseTarget ? "revision" : `${variantCount} variant${variantCount !== 1 ? "s" : ""}`}… this
              can take up to a minute.
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Composer */}
        <div className="space-y-2 rounded-lg border border-border bg-card p-3">
          {reviseTarget && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Wand2 className="h-3.5 w-3.5 text-primary" />
              Revising a selected result — describe the change and send.
              <button type="button" onClick={() => setReviseTarget(null)} aria-label="Cancel revision">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {!reviseTarget && attached.length > 0 && (
            <div className="flex flex-wrap gap-1.5" data-testid="attached-chips">
              {attached.map((input) => (
                <span
                  key={input.localId}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 py-0.5 pl-1 pr-1.5 text-xs"
                >
                  {input.previewUrl && (
                    <img src={input.previewUrl} alt="" className="h-5 w-5 rounded-full object-cover" />
                  )}
                  <span className="max-w-28 truncate">{input.name}</span>
                  <Select
                    value={input.role}
                    onValueChange={(role) =>
                      setAttached((prev) =>
                        prev.map((i) => (i.localId === input.localId ? { ...i, role: role as GenerationInputRole } : i)),
                      )
                    }
                  >
                    <SelectTrigger className="h-5 w-24 border-none bg-transparent px-1 text-[10px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(ROLE_LABELS) as GenerationInputRole[]).map((role) => (
                        <SelectItem key={role} value={role}>
                          {ROLE_LABELS[role]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <button
                    type="button"
                    onClick={() => setAttached((prev) => prev.filter((i) => i.localId !== input.localId))}
                    aria-label="Remove attachment"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={
                reviseTarget
                  ? 'e.g. "Make the headline larger and use more red"'
                  : chatLog.length > 0
                    ? "Reply — answer questions or refine the direction…"
                    : 'e.g. "A social graphic announcing our spring tournament"'
              }
              className="min-h-[52px] flex-1 resize-none text-sm"
              data-testid="prompt-input"
            />
            <Button
              type="button"
              size="sm"
              className="mb-0.5 gap-1.5"
              onClick={handleSend}
              disabled={!draft.trim() || generate.isPending || planner.isPending}
              data-testid="send-btn"
              aria-label="Send"
            >
              {planner.isPending || (generate.isPending && reviseTarget) ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <SendHorizonal className="h-4 w-4" />
              )}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!reviseTarget && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleUploadReference(file);
                    e.target.value = "";
                  }}
                />
                {/* Mobile: secondary controls live behind a settings popover. */}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="gap-1.5 sm:hidden"
                      aria-label="Generation settings"
                      data-testid="mobile-settings-btn"
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-60 space-y-3">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="w-full justify-start gap-1.5"
                      disabled={isUploading}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {isUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                      Upload reference
                    </Button>
                    <div className="space-y-1">
                      <p className="text-[11px] font-medium text-muted-foreground">Format</p>
                      <Select value={format} onValueChange={(v) => setFormat(v as GenerationFormatId)}>
                        <SelectTrigger className="h-8 w-full text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {FORMATS.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {f.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[11px] font-medium text-muted-foreground">Variants</p>
                      <Select value={String(variantCount)} onValueChange={(v) => setVariantCount(parseInt(v, 10))}>
                        <SelectTrigger className="h-8 w-full text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[1, 2, 3].map((n) => (
                            <SelectItem key={n} value={String(n)}>
                              {n} variant{n !== 1 ? "s" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </PopoverContent>
                </Popover>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => setPickerOpen(true)}
                  data-testid="add-from-vispix-btn"
                >
                  <Images className="h-3.5 w-3.5" /> Add from Vispix
                </Button>
                {/* Desktop: the same controls inline. */}
                <div className="hidden items-center gap-2 sm:flex">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    disabled={isUploading}
                    onClick={() => fileInputRef.current?.click()}
                    data-testid="upload-reference-btn"
                  >
                    {isUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                    Reference
                  </Button>
                  <Select value={format} onValueChange={(v) => setFormat(v as GenerationFormatId)}>
                    <SelectTrigger className="h-8 w-32 text-xs" data-testid="format-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FORMATS.map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          {f.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={String(variantCount)} onValueChange={(v) => setVariantCount(parseInt(v, 10))}>
                    <SelectTrigger className="h-8 w-28 text-xs" data-testid="variant-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[1, 2, 3].map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n} variant{n !== 1 ? "s" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <span className="ml-auto hidden text-[11px] text-muted-foreground/70 sm:inline">
                  Enter to send · Shift+Enter for a new line
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <VispixPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={(input) => setAttached((prev) => [...prev, { ...input, localId: crypto.randomUUID() }])}
      />
    </AppLayout>
  );
}
