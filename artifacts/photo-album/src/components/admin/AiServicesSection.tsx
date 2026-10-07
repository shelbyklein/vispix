import { useState } from "react";
import {
  useGetAiSettings,
  useUpdateAiSettings,
  useSetAiProviderKey,
  useClearAiProviderKey,
  useListAiAnalysisEvents,
  useRetryAiAnalysisEvent,
  useBulkRetryAiAnalysisEvents,
  getGetAiSettingsQueryKey,
  getListAiAnalysisEventsQueryKey,
  type AiSettings,
  type AiProviderInfo,
  type AiAnalysisEvent,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkles, KeyRound, AlertTriangle, Check, Activity, CircleX, MinusCircle, CheckCircle2, RotateCcw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/format-date";

type ProviderId = "openai" | "anthropic" | "gemini";

const PROVIDER_ORDER: ProviderId[] = ["openai", "anthropic", "gemini"];

export function AiServicesSection() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: settings, isLoading } = useGetAiSettings();
  const { mutate: updateSettings, isPending: updating } = useUpdateAiSettings();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getGetAiSettingsQueryKey() });

  function handleToggleEnabled(enabled: boolean) {
    updateSettings(
      { data: { enabled } },
      {
        onSuccess: () => {
          invalidate();
          toast({
            title: enabled ? "AI photo analysis turned on" : "AI photo analysis turned off",
          });
        },
        onError: () =>
          toast({ title: "Failed to update settings", variant: "destructive" }),
      },
    );
  }

  function handleSetActive(activeProvider: ProviderId) {
    updateSettings(
      { data: { activeProvider } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: `Active provider set to ${activeProvider}` });
        },
        onError: () =>
          toast({ title: "Failed to update active provider", variant: "destructive" }),
      },
    );
  }

  function handleSetModel(provider: ProviderId, model: string) {
    updateSettings(
      { data: { providerModels: { [provider]: model } } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: `Model updated to ${model}` });
        },
        onError: () =>
          toast({ title: "Failed to update model", variant: "destructive" }),
      },
    );
  }

  if (isLoading || !settings) {
    return (
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold text-foreground">AI Services</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Loading…</p>
          </div>
        </div>
        <div className="p-5 space-y-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-32 w-full rounded-lg" />
          <Skeleton className="h-32 w-full rounded-lg" />
          <Skeleton className="h-32 w-full rounded-lg" />
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border border-border bg-card overflow-hidden"
      data-testid="ai-services-section"
    >
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-muted-foreground" />
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-foreground">AI Services</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Choose which AI service describes uploaded photos and suggests collections.
          </p>
        </div>
      </div>

      <div className="p-5 space-y-5">
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-background/50 px-4 py-3">
          <div>
            <Label htmlFor="ai-enabled" className="text-sm font-medium">
              AI photo analysis enabled
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              When off, uploads skip AI analysis entirely.
            </p>
          </div>
          <Switch
            id="ai-enabled"
            checked={settings.enabled}
            onCheckedChange={handleToggleEnabled}
            disabled={updating}
            data-testid="ai-enabled-switch"
          />
        </div>

        {settings.enabled && !settings.hasUsableActive && (
          <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
            <AlertTriangle className="h-4 w-4 text-warning-foreground mt-0.5 shrink-0" />
            <p className="text-warning-foreground">
              The active provider has no API key and no built-in fallback. New uploads
              will be saved without AI descriptions until you add a key below.
            </p>
          </div>
        )}

        <RadioGroup
          value={settings.activeProvider}
          onValueChange={(v) => handleSetActive(v as ProviderId)}
          className="space-y-3"
          disabled={updating || !settings.enabled}
        >
          {PROVIDER_ORDER.map((id) => (
            <ProviderCard
              key={id}
              provider={settings.providers[id]}
              isActive={settings.activeProvider === id}
              disabled={!settings.enabled}
              onModelChange={(model) => handleSetModel(id, model)}
              modelChangeDisabled={updating || !settings.enabled}
            />
          ))}
        </RadioGroup>

        <RecentActivityPanel />
      </div>
    </div>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return formatDate(iso);
}

function StatusIcon({ status }: { status: AiAnalysisEvent["status"] }) {
  if (status === "success")
    return <CheckCircle2 className="h-3.5 w-3.5 text-success-foreground" />;
  if (status === "failed")
    return <CircleX className="h-3.5 w-3.5 text-destructive" />;
  return <MinusCircle className="h-3.5 w-3.5 text-muted-foreground" />;
}

function RecentActivityPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: events, isLoading } = useListAiAnalysisEvents({
    query: {
      queryKey: getListAiAnalysisEventsQueryKey(),
      refetchInterval: 10000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    },
  });
  const { mutate: retry, isPending: retrying, variables: retryingVars } =
    useRetryAiAnalysisEvent();
  const { mutate: bulkRetry, isPending: bulkRetrying } =
    useBulkRetryAiAnalysisEvents();
  const retryingId = retrying ? retryingVars?.id : null;

  const failedCount = events
    ? events.filter((e) => e.status === "failed" && e.photoId != null).length
    : 0;

  function handleRetry(id: number) {
    retry(
      { id },
      {
        onSuccess: (newEvent) => {
          qc.invalidateQueries({ queryKey: getListAiAnalysisEventsQueryKey() });
          toast({
            title:
              newEvent.status === "success"
                ? "AI analysis succeeded"
                : newEvent.status === "skipped"
                  ? "AI analysis skipped"
                  : "AI analysis failed again",
          });
        },
        onError: () =>
          toast({ title: "Retry failed", variant: "destructive" }),
      },
    );
  }

  function handleBulkRetry() {
    bulkRetry(undefined, {
      onSuccess: (result) => {
        qc.invalidateQueries({ queryKey: getListAiAnalysisEventsQueryKey() });
        const parts: string[] = [];
        if (result.succeeded > 0)
          parts.push(`${result.succeeded} succeeded`);
        if (result.skipped > 0)
          parts.push(`${result.skipped} skipped`);
        if (result.failed > 0)
          parts.push(`${result.failed} failed`);
        const total = result.succeeded + result.skipped + result.failed;
        toast({
          title:
            total === 0
              ? "No failed photos to retry"
              : result.failed === 0
                ? "All retries succeeded"
                : `Retries complete: ${parts.join(", ")}`,
        });
      },
      onError: () =>
        toast({ title: "Bulk retry failed", variant: "destructive" }),
    });
  }

  return (
    <div
      className="rounded-lg border border-border bg-background/30 overflow-hidden"
      data-testid="ai-activity-panel"
    >
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <Activity className="h-4 w-4 text-muted-foreground" />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-foreground">Recent AI activity</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Last 20 photo analysis attempts. Use this to spot key or quota issues.
          </p>
        </div>
        {failedCount > 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-3 text-xs shrink-0"
            onClick={handleBulkRetry}
            disabled={bulkRetrying || retrying}
            data-testid="ai-activity-retry-all"
          >
            <RotateCcw className="h-3 w-3 mr-1" />
            {bulkRetrying ? "Retrying all…" : `Retry all failed (${failedCount})`}
          </Button>
        )}
      </div>
      <div className="p-3">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : !events || events.length === 0 ? (
          <div
            className="text-center py-6 text-xs text-muted-foreground"
            data-testid="ai-activity-empty"
          >
            No AI activity yet. Upload a photo to see analysis attempts here.
          </div>
        ) : (
          <ul
            className="divide-y divide-border rounded-md border border-border overflow-hidden"
            data-testid="ai-activity-list"
          >
            {events.map((ev) => (
              <li
                key={ev.id}
                className="flex items-start gap-3 px-3 py-2.5 bg-background/40"
                data-testid={`ai-activity-row-${ev.id}`}
              >
                {ev.photoThumbnailUrl ? (
                  <img
                    src={ev.photoThumbnailUrl}
                    alt=""
                    className="h-8 w-8 rounded object-cover shrink-0 border border-border"
                  />
                ) : (
                  <div className="h-8 w-8 rounded bg-muted shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <StatusIcon status={ev.status} />
                    <span className="text-xs font-medium text-foreground capitalize">
                      {ev.status}
                    </span>
                    {ev.provider && (
                      <span className="text-xs text-muted-foreground font-mono">
                        {ev.provider}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground ml-auto">
                      {formatRelative(ev.createdAt)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground truncate">
                    {ev.photoCaption ||
                      (ev.photoId ? `Photo #${ev.photoId}` : "Photo deleted")}
                  </div>
                  {ev.errorMessage && (
                    <div
                      className="mt-1 text-xs text-destructive break-words"
                      data-testid={`ai-activity-error-${ev.id}`}
                    >
                      {ev.errorMessage}
                    </div>
                  )}
                  {ev.status === "failed" && ev.photoId != null && (
                    <div className="mt-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        onClick={() => handleRetry(ev.id)}
                        disabled={retryingId === ev.id}
                        data-testid={`ai-activity-retry-${ev.id}`}
                      >
                        <RotateCcw className="h-3 w-3 mr-1" />
                        {retryingId === ev.id ? "Retrying…" : "Retry"}
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ProviderCard({
  provider,
  isActive,
  disabled,
  onModelChange,
  modelChangeDisabled,
}: {
  provider: AiProviderInfo;
  isActive: boolean;
  disabled: boolean;
  onModelChange: (model: string) => void;
  modelChangeDisabled: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [keyInput, setKeyInput] = useState("");
  const { mutate: saveKey, isPending: saving } = useSetAiProviderKey();
  const { mutate: clearKey, isPending: clearing } = useClearAiProviderKey();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getGetAiSettingsQueryKey() });

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const apiKey = keyInput.trim();
    if (apiKey.length < 4) return;
    saveKey(
      { provider: provider.id, data: { apiKey } },
      {
        onSuccess: () => {
          setKeyInput("");
          invalidate();
          toast({ title: `${provider.label} key saved` });
        },
        onError: () =>
          toast({ title: `Failed to save ${provider.label} key`, variant: "destructive" }),
      },
    );
  }

  function handleClear() {
    clearKey(
      { provider: provider.id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: `${provider.label} key cleared` });
        },
        onError: () =>
          toast({ title: `Failed to clear ${provider.label} key`, variant: "destructive" }),
      },
    );
  }

  return (
    <div
      className={`rounded-lg border bg-background/30 p-4 transition-colors ${
        isActive ? "border-primary/60 bg-primary/5" : "border-border"
      } ${disabled ? "opacity-60" : ""}`}
      data-testid={`provider-card-${provider.id}`}
    >
      <div className="flex items-start gap-3">
        <RadioGroupItem
          value={provider.id}
          id={`provider-${provider.id}`}
          className="mt-1"
          disabled={disabled}
          data-testid={`provider-radio-${provider.id}`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <Label
              htmlFor={`provider-${provider.id}`}
              className="text-sm font-semibold cursor-pointer"
            >
              {provider.label}
              {isActive && (
                <span className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-primary">
                  <Check className="h-3 w-3" /> active
                </span>
              )}
            </Label>
            <Select
              value={provider.model}
              onValueChange={onModelChange}
              disabled={modelChangeDisabled}
            >
              <SelectTrigger
                className="h-8 w-auto min-w-[220px] text-xs font-mono"
                data-testid={`provider-model-trigger-${provider.id}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {provider.availableModels.map((m) => (
                  <SelectItem
                    key={m.id}
                    value={m.id}
                    textValue={m.id}
                    className="text-xs"
                    data-testid={`provider-model-option-${provider.id}-${m.id}`}
                  >
                    <div className="flex flex-col">
                      <span className="font-mono">{m.id}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {m.label}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="mt-1 text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
            {provider.hasKey ? (
              <span className="inline-flex items-center gap-1">
                <KeyRound className="h-3 w-3" />
                Key saved:{" "}
                <span className="font-mono text-foreground">
                  {provider.keyPreview ?? "•••"}
                </span>
              </span>
            ) : provider.envKeyFallbackAvailable ? (
              <span>No admin key — using server env fallback key</span>
            ) : (
              <span className="text-warning-foreground">No key configured</span>
            )}
          </div>

          <form
            onSubmit={handleSave}
            className="mt-3 flex flex-wrap gap-2 items-center"
            data-testid={`provider-key-form-${provider.id}`}
          >
            <Input
              type="password"
              autoComplete="off"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={
                provider.hasKey
                  ? "Paste a new key to replace…"
                  : `Paste your ${provider.label} API key…`
              }
              className="h-9 text-sm flex-1 min-w-[220px]"
              data-testid={`provider-key-input-${provider.id}`}
            />
            <Button
              type="submit"
              size="sm"
              className="h-9"
              disabled={keyInput.trim().length < 4 || saving}
              data-testid={`save-provider-key-${provider.id}`}
            >
              {provider.hasKey ? "Replace" : "Save"}
            </Button>
            {provider.hasKey && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-9"
                onClick={handleClear}
                disabled={clearing}
                data-testid={`clear-provider-key-${provider.id}`}
              >
                Clear key
              </Button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

export type { AiSettings };
