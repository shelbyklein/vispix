import {
  useAdminOrganizations,
  useDeleteOrganization,
  useJoinOrganization,
  useSetOrgPlan,
  type AdminOrganization,
} from "@workspace/api-client-react";
import { AdminSectionShell } from "@/components/admin/AdminSectionShell";
import { DangerConfirmDialog } from "@/components/admin/DangerConfirmDialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Building2, Loader2, UserPlus, BadgeCheck, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/format-date";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function OrgRow({ org }: { org: AdminOrganization }) {
  const { toast } = useToast();
  const { mutate: setPlan, isPending: planPending } = useSetOrgPlan();
  const { mutate: join, isPending: joining } = useJoinOrganization();
  const { mutate: deleteOrg, isPending: deleting } = useDeleteOrganization();

  function handlePlanChange(plan: "free" | "pro" | "enterprise") {
    if (plan === org.plan) return;
    setPlan(
      { organizationId: org.id, plan },
      {
        onSuccess: () => toast({ title: `${org.name} is now on ${plan}` }),
        onError: () => toast({ title: "Couldn't change the plan", variant: "destructive" }),
      },
    );
  }

  function handleJoin() {
    join(org.id, {
      onSuccess: ({ alreadyMember }) =>
        toast({
          title: alreadyMember ? `Already a member of ${org.name}` : `Joined ${org.name} as admin`,
          description: alreadyMember ? undefined : "Switch to it from the org menu in the sidebar.",
        }),
      onError: () => toast({ title: "Couldn't join the organization", variant: "destructive" }),
    });
  }

  function handleDelete(confirm: string) {
    deleteOrg(
      { organizationId: org.id, confirm },
      {
        onSuccess: (result) =>
          toast({
            title: `Deleted ${result.name}`,
            description: `${result.photosDeleted.toLocaleString()} photo${result.photosDeleted !== 1 ? "s" : ""} and ${result.objectsDeleted.toLocaleString()} stored file${result.objectsDeleted !== 1 ? "s" : ""} removed${result.subscriptionCancelled ? "; Stripe subscription cancelled" : ""}.`,
          }),
        onError: (err) =>
          toast({
            title: "Couldn't delete the organization",
            description: err instanceof Error ? err.message : undefined,
            variant: "destructive",
          }),
      },
    );
  }

  const overCap = org.capBytes != null && org.usageBytes >= org.capBytes;

  return (
    <div className="px-5 py-4 flex flex-wrap items-center gap-x-6 gap-y-2" data-testid={`org-row-${org.slug}`}>
      <div className="min-w-0 flex-1 basis-52">
        <p className="text-sm font-semibold text-foreground truncate">{org.name}</p>
        <p className="text-xs text-muted-foreground truncate">
          {org.slug} · created {formatDate(org.createdAt)}
        </p>
      </div>

      <div className="text-xs text-muted-foreground w-32">
        <p className="font-medium text-foreground">
          {org.memberCount} member{org.memberCount !== 1 ? "s" : ""}
        </p>
        <p>
          {org.photoCount.toLocaleString()} photo{org.photoCount !== 1 ? "s" : ""}
        </p>
      </div>

      <div className="text-xs w-36">
        <p className={`font-medium ${overCap ? "text-red-600 dark:text-red-500" : "text-foreground"}`}>
          {formatBytes(org.usageBytes)}
          {org.capBytes == null ? " — unlimited" : ` / ${formatBytes(org.capBytes)}`}
        </p>
        <p className="text-muted-foreground capitalize">{org.subscriptionStatus.replace(/_/g, " ")}</p>
      </div>

      <Select value={org.plan} onValueChange={handlePlanChange} disabled={planPending}>
        <SelectTrigger className="w-32 h-8 text-xs" data-testid={`plan-select-${org.slug}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="free">Free</SelectItem>
          <SelectItem value="pro">Pro</SelectItem>
          <SelectItem value="enterprise">Enterprise</SelectItem>
        </SelectContent>
      </Select>

      {org.myRole ? (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground w-28">
          <BadgeCheck className="h-3.5 w-3.5 text-primary" />
          Member ({org.myRole})
        </span>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 w-28"
          onClick={handleJoin}
          disabled={joining}
          data-testid={`join-org-${org.slug}`}
        >
          {joining ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
          Join
        </Button>
      )}

      <DangerConfirmDialog
        testId={`delete-org-${org.slug}`}
        trigger={
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            disabled={deleting}
            aria-label={`Delete ${org.name}`}
          >
            {deleting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4 text-destructive" />
            )}
          </Button>
        }
        title={`Delete "${org.name}"?`}
        phrase={org.slug}
        phraseLabel={`Type the org's slug (${org.slug}) to confirm`}
        confirmLabel="Delete organization"
        pending={deleting}
        onConfirm={handleDelete}
        description={
          <>
            <p>
              This permanently removes {org.memberCount} member
              {org.memberCount !== 1 ? "s" : ""}, {org.photoCount.toLocaleString()} photo
              {org.photoCount !== 1 ? "s" : ""} ({formatBytes(org.usageBytes)}) and every album,
              collection, project, campaign and asset in this organization — including the
              underlying files in storage.
            </p>
            <p>
              Any active subscription is cancelled. This cannot be undone and there is no backup to
              restore from.
            </p>
          </>
        }
      />
    </div>
  );
}

export default function AdminOrganizationsPage() {
  const { data: orgs, isLoading } = useAdminOrganizations();

  return (
    <AdminSectionShell
      title="Organizations"
      scope="platform"
      icon={Building2}
      description="Every organization on the platform — plans, usage, and support access."
    >
      {isLoading || !orgs ? (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-5 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">All organizations</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {orgs.length} organization{orgs.length !== 1 ? "s" : ""}. Joining adds you to that
              org's member list as an admin — visible to the customer.
            </p>
          </div>
          <div className="divide-y divide-border">
            {orgs.map((org) => (
              <OrgRow key={org.id} org={org} />
            ))}
          </div>
        </div>
      )}
    </AdminSectionShell>
  );
}
