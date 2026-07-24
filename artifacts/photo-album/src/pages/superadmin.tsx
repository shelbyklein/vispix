import { useGetMe } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Skeleton } from "@/components/ui/skeleton";
import { Shield, UserPlus, Users, ChevronRight, Building2, BarChart3 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ServiceReadinessCard } from "@/components/admin/ServiceReadinessCard";
import { SendTestEmailCard } from "@/components/admin/SendTestEmailCard";

// Superadmin hub (issue #120): the platform operator's cross-organization
// tools, split out from the org-scoped /admin area. Platform admins only.
const SECTIONS: { href: string; title: string; description: string; icon: LucideIcon }[] = [
  { href: "/superadmin/analytics", title: "Analytics", description: "Platform usage across every organization — growth, activity, revenue.", icon: BarChart3 },
  { href: "/superadmin/organizations", title: "Organizations", description: "All organizations — plans, usage, and support access.", icon: Building2 },
  { href: "/superadmin/users", title: "Users", description: "Every registered account, platform roles, and org memberships.", icon: Users },
  { href: "/superadmin/registration", title: "Registration", description: "Allow or pause new account sign-ups.", icon: UserPlus },
  // ?org=1 suppresses the platform-admin → /superadmin default redirect.
  { href: "/admin?org=1", title: "This organization", description: "Org-scoped admin for the organization you're currently in.", icon: Shield },
];

export default function Superadmin() {
  const { data: me, isLoading: meLoading } = useGetMe();

  if (meLoading) {
    return (
      <AppLayout>
        <div className="space-y-6">
          <Skeleton className="h-10 w-48" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </AppLayout>
    );
  }

  if (!me || me.role !== "admin") {
    return (
      <AppLayout>
        <div className="text-center py-24">
          <p className="text-muted-foreground">You do not have permission to view this page.</p>
          <Link href="/dashboard"><Button variant="outline" className="mt-4">Back to Dashboard</Button></Link>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-8" data-testid="superadmin-page">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
            <Shield className="h-5 w-5 text-amber-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Superadmin</h1>
            <p className="text-sm text-muted-foreground">Platform-level tools across every organization.</p>
          </div>
        </div>

        <ServiceReadinessCard variant="platform" enabled={me.role === "admin"} />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="superadmin-grid">
          {SECTIONS.map((section) => {
            const Icon = section.icon;
            return (
              <Link
                key={section.href}
                href={section.href}
                className="group flex items-start gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-amber-500/40 hover:bg-accent/50"
                data-testid={`superadmin-card-${section.href.split("/").pop()}`}
              >
                <div className="h-9 w-9 shrink-0 rounded-lg bg-amber-500/10 flex items-center justify-center">
                  <Icon className="h-[18px] w-[18px] text-amber-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-foreground flex items-center gap-1">
                    {section.title}
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 -translate-x-1 transition-all group-hover:opacity-100 group-hover:translate-x-0" />
                  </h3>
                  <p className="text-xs text-muted-foreground mt-0.5">{section.description}</p>
                </div>
              </Link>
            );
          })}
          {/* Action tile among the nav cards — the whole card sends. */}
          <SendTestEmailCard />
        </div>
      </div>
    </AppLayout>
  );
}
