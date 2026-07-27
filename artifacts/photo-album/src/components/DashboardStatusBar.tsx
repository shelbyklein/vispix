import { Link } from "wouter";
import type { LucideIcon } from "lucide-react";
import { useGetMe, useAdminHubStatus, useOrgServiceStatus } from "@workspace/api-client-react";
import { useOrg } from "@/contexts/OrgContext";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { CalendarDays, Plug, Sparkles, Layers, Cpu, CopyCheck } from "lucide-react";

// Library-health status bar on the dashboard: one compact chip per subsystem
// (captured dates, AI connection, AI analysis, embeddings, AI services,
// duplicates), each linking to the admin page that fixes it. Data comes from
// the existing admin hub-status + org service-status endpoints, so the bar is
// only shown to users who can act on it (org owners/admins + platform admins).

type Tone = "ok" | "warn" | "err";

const TONE_CLASSES: Record<Tone, string> = {
  ok: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
  warn: "border-amber-500/50 text-amber-700 dark:text-amber-400",
  err: "border-destructive/50 text-destructive",
};

function StatusChip({
  href,
  icon: Icon,
  label,
  value,
  tone,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  value: string;
  tone: Tone;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border bg-background/60 px-2.5 py-1 text-xs transition-colors hover:bg-muted/60",
        TONE_CLASSES[tone],
      )}
      title={`${label}: ${value}`}
      data-testid={`status-chip-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="font-medium text-foreground/80">{label}</span>
      <span className="tabular-nums">{value}</span>
    </Link>
  );
}

export function DashboardStatusBar() {
  const { data: me } = useGetMe();
  const { activeOrg } = useOrg();
  const canSee =
    me?.role === "admin" || activeOrg?.role === "owner" || activeOrg?.role === "admin";

  const hub = useAdminHubStatus({ enabled: canSee });
  const svc = useOrgServiceStatus({ enabled: canSee });

  if (!canSee) return null;
  if (hub.isLoading || svc.isLoading) {
    return (
      <div className="flex flex-wrap gap-2" data-testid="dashboard-status-bar">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-7 w-32 rounded-full" />
        ))}
      </div>
    );
  }
  if (!hub.data || !svc.data) return null;

  const aiRow = svc.data.services.find((s) => s.key === "ai");
  const pending = (n: number, noun = "pending") =>
    n === 0 ? "up to date" : `${n.toLocaleString()} ${noun}`;

  const chips: { href: string; icon: LucideIcon; label: string; value: string; tone: Tone }[] = [
    {
      href: "/admin/captured-dates",
      icon: CalendarDays,
      label: "Captured dates",
      value: pending(hub.data.capturedDatesMissing, "missing"),
      tone: hub.data.capturedDatesMissing === 0 ? "ok" : "warn",
    },
    {
      href: "/admin/ai-services",
      icon: Plug,
      label: "AI connection",
      value: aiRow?.ok ? "connected" : "not configured",
      tone: aiRow?.ok ? "ok" : "err",
    },
    {
      href: "/admin/ai-analysis",
      icon: Sparkles,
      label: "AI analysis",
      value: pending(hub.data.aiAnalysisPending),
      tone: hub.data.aiAnalysisPending === 0 ? "ok" : "warn",
    },
    {
      href: "/admin/embeddings",
      icon: Layers,
      label: "Embeddings",
      value: pending(hub.data.embeddingsPending),
      tone: hub.data.embeddingsPending === 0 ? "ok" : "warn",
    },
    {
      href: "/admin/ai-services",
      icon: Cpu,
      label: "AI services",
      value: svc.data.ready ? "ready" : "needs attention",
      tone: svc.data.ready ? "ok" : "err",
    },
    {
      href: "/admin/duplicates",
      icon: CopyCheck,
      label: "Duplicates",
      value: hub.data.duplicateGroups === 0 ? "none" : `${hub.data.duplicateGroups.toLocaleString()} groups`,
      tone: hub.data.duplicateGroups === 0 ? "ok" : "warn",
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
