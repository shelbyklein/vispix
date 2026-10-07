import { useGetMe, usePlatformAnalytics, type AnalyticsPoint } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import {
  BarChart3,
  Building2,
  Users,
  Image as ImageIcon,
  Activity,
  UserPlus,
  Upload,
  Star,
  HardDrive,
  DollarSign,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// Tiny dependency-free SVG area chart for a daily series. Uses a viewBox so it
// scales to its container; a flat baseline is drawn when every value is 0.
function AreaChart({ data }: { data: AnalyticsPoint[] }) {
  const W = 300;
  const H = 56;
  const max = Math.max(1, ...data.map((d) => d.count));
  const n = data.length;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (v: number) => H - (v / max) * (H - 4) - 2;
  const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.count).toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-2 h-14 w-full" role="img" aria-hidden>
      <path d={area} className="fill-primary/10" />
      <path d={line} className="fill-none stroke-primary" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function TrendCard({ title, icon: Icon, data }: { title: string; icon: LucideIcon; data: AnalyticsPoint[] }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  return (
    <div className="rounded-xl border border-border bg-card p-4" data-testid={`analytics-trend-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
        </div>
        <span className="text-sm text-muted-foreground">{total} in 30d</span>
      </div>
      <AreaChart data={data} />
    </div>
  );
}

function StatCard({ title, value, sub, icon: Icon }: { title: string; value: string; sub?: string; icon: LucideIcon }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {title}
      </div>
      <div className="mt-1 text-2xl font-bold text-foreground">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export default function SuperadminAnalytics() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const isAdmin = me?.role === "admin";
  const { data, isLoading } = usePlatformAnalytics({ enabled: isAdmin });

  if (!meLoading && !isAdmin) {
    return (
      <AppLayout>
        <div className="text-center py-24">
          <p className="text-muted-foreground">You do not have permission to view this page.</p>
          <Link href="/dashboard"><Button variant="outline" className="mt-4">Back to Dashboard</Button></Link>
        </div>
      </AppLayout>
    );
  }

  const t = data?.totals;
  const plans = t?.planCounts ?? {};

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="superadmin-analytics-page">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-warning/10 flex items-center justify-center">
            <BarChart3 className="h-5 w-5 text-warning-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Analytics</h1>
            <p className="text-sm text-muted-foreground">Platform usage across every organization (last 30 days).</p>
          </div>
        </div>

        {isLoading || !data ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard title="Organizations" value={String(t!.organizations)} icon={Building2} sub={`Free ${plans.free ?? 0} · Pro ${plans.pro ?? 0} · Ent ${plans.enterprise ?? 0}`} />
              <StatCard title="Users" value={String(t!.users)} icon={Users} />
              <StatCard title="Photos" value={t!.photos.toLocaleString()} icon={ImageIcon} sub={formatBytes(t!.storageBytes)} />
              <StatCard title="Active users" value={String(t!.activeUsers7d)} icon={Activity} sub={`${t!.activeUsers30d} in 30d`} />
              <StatCard title="MRR" value={`$${(t!.mrrCents / 100).toFixed(2)}`} icon={DollarSign} sub={`${plans.pro ?? 0} Pro${t!.canceledSubscriptions > 0 ? ` · ${t!.canceledSubscriptions} canceled` : ""}`} />
              <StatCard title="Storage" value={formatBytes(t!.storageBytes)} icon={HardDrive} />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <TrendCard title="Signups" icon={UserPlus} data={data.series.signups} />
              <TrendCard title="New orgs" icon={Building2} data={data.series.newOrgs} />
              <TrendCard title="Uploads" icon={Upload} data={data.series.uploads} />
              <TrendCard title="Logins" icon={Activity} data={data.series.logins} />
              <TrendCard title="Ratings" icon={Star} data={data.series.ratings} />
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}
