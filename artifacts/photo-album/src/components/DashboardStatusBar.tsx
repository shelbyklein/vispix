import { Link } from "wouter";
import type { LucideIcon } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import {
  useGetMe,
  useAdminHubStatus,
  useLibraryHealth,
  type HealthState,
  type ServiceHealth,
} from "@workspace/api-client-react";
import { useOrg } from "@/contexts/OrgContext";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { CalendarDays, Plug, Sparkles, Layers, Search, CopyCheck, Copy } from "lucide-react";

// Library-health status bar on the dashboard: one compact chip per subsystem,
// each linking to the admin page that fixes it. Chips separate three things
// that used to be blurred together (#217): whether a service is merely
// CONFIGURED, whether it has been seen WORKING (or failing) on a real
// operation, and how much of the library has actually been PROCESSED. Data
// comes from the org-scoped admin hub-status + library-health endpoints, which
// read recorded outcomes only — loading this bar never calls an AI provider.
// It is only shown to users who can act on it (org owners/admins + platform admins).

type Tone = "ok" | "warn" | "err";

const TONE_CLASSES: Record<Tone, string> = {
  ok: "border-success/40 text-success-foreground",
  warn: "border-warning/50 text-warning-foreground",
  err: "border-destructive/50 text-destructive",
};

function StatusChip({
  href,
  icon: Icon,
  label,
  value,
  tone,
  title,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  value: string;
  tone: Tone;
  title?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border bg-background/60 px-2.5 py-1 text-xs transition-colors hover:bg-muted/60",
        TONE_CLASSES[tone],
      )}
      title={title ?? `${label}: ${value}`}
      data-testid={`status-chip-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="font-medium text-foreground/80">{label}</span>
      <span className="tabular-nums">{value}</span>
    </Link>
  );
}

const n = (v: number) => v.toLocaleString();
const ago = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true });
const plural = (count: number, one: string, many: string) => `${n(count)} ${count === 1 ? one : many}`;

/** Service state as a short phrase. "configured" never reads as "connected". */
export function serviceStateText(s: ServiceHealth): string {
  switch (s.state) {
    case "not_configured":
      return "not configured";
    case "configured":
      return "configured, not yet verified";
    case "working":
      return s.lastSuccessAt ? `working, last success ${ago(s.lastSuccessAt)}` : "working";
    case "failing": {
      const why = s.failureReason ? s.failureReason.message.toLowerCase() : "last attempt failed";
      return `failing: ${why}${s.lastFailureAt ? `, ${ago(s.lastFailureAt)}` : ""}`;
    }
    case "stale": {
      const last = [s.lastSuccessAt, s.lastFailureAt].filter((x): x is string => !!x).sort().pop();
      return last ? `stale, last seen ${ago(last)}` : "stale";
    }
  }
}

const STATE_TONE: Record<HealthState, Tone> = {
  not_configured: "err",
  configured: "warn",
  working: "ok",
  failing: "err",
  stale: "warn",
};

const worse = (a: Tone, b: Tone): Tone => (a === "err" || b === "err" ? "err" : a === "warn" || b === "warn" ? "warn" : "ok");

function exactTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "never";
}

function serviceTitle(label: string, s: ServiceHealth): string {
  return [
    `${label}: ${serviceStateText(s)}`,
    `Last success: ${exactTime(s.lastSuccessAt)}`,
    `Last failure: ${exactTime(s.lastFailureAt)}`,
  ].join("\n");
}

export function DashboardStatusBar() {
  const { data: me } = useGetMe();
  const { activeOrg } = useOrg();
  const canSee =
    me?.role === "admin" || activeOrg?.role === "owner" || activeOrg?.role === "admin";

  const hub = useAdminHubStatus({ enabled: canSee });
  const health = useLibraryHealth({ enabled: canSee });

  if (!canSee) return null;
  if (hub.isLoading || health.isLoading) {
    return (
      <div className="flex flex-wrap gap-2" data-testid="dashboard-status-bar">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-7 w-32 rounded-full" />
        ))}
      </div>
    );
  }
  if (!hub.data || !health.data) return null;

  const { imageAnalysis: ia, imageEmbeddings: ie, searchEmbedding: se, duplicates: dup } = health.data;
  const a = ia.coverage;
  const e = ie.coverage;

  const analysisParts = [`${n(a.analysed)} of ${n(a.total)} analysed`];
  if (a.failed > 0) analysisParts.push(`${n(a.failed)} failed`);
  if (a.pending > 0) analysisParts.push(`${n(a.pending)} pending`);

  const embedParts = [`${n(e.embedded)} of ${n(e.total)} embedded`];
  if (e.missing > 0) embedParts.push(`${n(e.missing)} pending`);
  if (e.refreshPending > 0) embedParts.push(`${n(e.refreshPending)} to refresh`);

  const coverageTone = (failed: number, pending: number): Tone => (failed > 0 ? "err" : pending > 0 ? "warn" : "ok");
  // Embeddings are optional, so "not configured" is a warning there, not an error.
  const optionalTone = (state: HealthState): Tone => (state === "not_configured" ? "warn" : STATE_TONE[state]);

  const chips: { href: string; icon: LucideIcon; label: string; value: string; tone: Tone; title?: string }[] = [
    {
      href: "/admin/captured-dates",
      icon: CalendarDays,
      label: "Captured dates",
      value: hub.data.capturedDatesMissing === 0 ? "up to date" : `${n(hub.data.capturedDatesMissing)} missing`,
      tone: hub.data.capturedDatesMissing === 0 ? "ok" : "warn",
    },
    {
      href: "/admin/ai-services",
      icon: Plug,
      label: "AI provider",
      value: serviceStateText(ia),
      tone: STATE_TONE[ia.state],
      title:
        serviceTitle("AI provider (photo analysis)", ia) +
        (ia.provider ? `\nConfigured provider: ${ia.provider}` : "") +
        (ia.lastUsedProvider ? `\nLast used: ${ia.lastUsedProvider}` : ""),
    },
    {
      href: "/admin/ai-analysis",
      icon: Sparkles,
      label: "Analysis",
      value: analysisParts.join(", "),
      tone: coverageTone(a.failed, a.pending),
      title: `Photo analysis coverage\n${analysisParts.join("\n")}`,
    },
    {
      href: "/admin/embeddings",
      icon: Layers,
      label: "Embeddings",
      value:
        embedParts.join(", ") + (ie.state === "working" || ie.state === "configured" ? "" : `; ${serviceStateText(ie)}`),
      tone: worse(coverageTone(0, e.missing + e.refreshPending), ie.state === "configured" ? "ok" : optionalTone(ie.state)),
      title: `${serviceTitle("Image embeddings", ie)}\n${embedParts.join("\n")}`,
    },
    {
      href: "/admin/embeddings",
      icon: Search,
      label: "Search",
      value: serviceStateText(se),
      tone: optionalTone(se.state),
      title: serviceTitle("Search query embedding (concept search)", se),
    },
    {
      href: "/admin/duplicates",
      icon: CopyCheck,
      label: "Exact duplicates",
      value:
        dup.exact.groups === 0
          ? "none"
          : `${plural(dup.exact.groups, "group", "groups")}, ${plural(dup.exact.extraCopies, "extra copy", "extra copies")}`,
      tone: dup.exact.groups === 0 ? "ok" : "warn",
      title: `Byte-identical files (matching content hash)\n${n(dup.exact.hashedPhotos)} of ${n(dup.exact.totalPhotos)} photos checked`,
    },
    {
      href: "/admin/near-duplicates",
      icon: Copy,
      label: "Near-duplicates",
      value:
        dup.near.groups === 0
          ? "none"
          : `${plural(dup.near.groups, "group", "groups")}, ${plural(dup.near.photos, "photo", "photos")}`,
      tone: dup.near.groups === 0 ? "ok" : "warn",
      title: `Visually similar photos (perceptual hash, up to ${dup.near.threshold} bits apart)\n${n(dup.near.indexedPhotos)} of ${n(dup.near.totalPhotos)} photos indexed`,
    },
  ];

  return (
    <div className="flex flex-wrap gap-2" data-testid="dashboard-status-bar">
      {chips.map((chip) => (
        <StatusChip key={chip.label} {...chip} />
      ))}
    </div>
  );
}
