import {
  useListUsers,
  useUpdateUserRole,
  getListUsersQueryKey,
  useGetMe,
  useAdminOrganizations,
  useAdminSetOrgMemberRole,
  useDeleteUser,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AdminSectionShell } from "@/components/admin/AdminSectionShell";
import { DangerConfirmDialog } from "@/components/admin/DangerConfirmDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Users, Trash2, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Platform Users (issue #120): every registered account across all customer
// organizations, with their org memberships. The role here is the PLATFORM
// role — "Platform admin" is the operator key (full access to every org and
// all admin tooling), not a per-org role (that's Organization Members).
export default function AdminTeamPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: me } = useGetMe();
  const isAdmin = me?.role === "admin";
  const { data: users, isLoading: usersLoading } = useListUsers({
    query: { enabled: isAdmin, queryKey: getListUsersQueryKey() },
  });
  const { data: orgs } = useAdminOrganizations({ enabled: isAdmin });

  // userId → their org memberships, derived from the org overview's rosters.
  const membershipsByUser = new Map<number, { orgId: number; orgName: string; role: string }[]>();
  for (const org of orgs ?? []) {
    for (const m of org.members) {
      const list = membershipsByUser.get(m.userId) ?? [];
      list.push({ orgId: org.id, orgName: org.name, role: m.role });
      membershipsByUser.set(m.userId, list);
    }
  }

  const { mutate: updateRole } = useUpdateUserRole();
  const { mutate: setOrgRole } = useAdminSetOrgMemberRole();
  const { mutate: deleteUser, isPending: deleting } = useDeleteUser();

  function handleDelete(userId: number, name: string, confirm: string) {
    deleteUser(
      { userId, confirm },
      {
        onSuccess: (result) =>
          toast({
            title: `Deleted ${name}`,
            description:
              result.reassignedTo.length > 0
                ? `Their content in ${result.reassignedTo
                    .map((r) => `${r.organizationName} → ${r.name}`)
                    .join(", ")}.`
                : undefined,
          }),
        onError: (err) =>
          toast({
            title: "Couldn't delete the user",
            // The server's refusals (sole member of an org, last platform
            // admin) explain what to do next, so surface them verbatim.
            description: err instanceof Error ? err.message : undefined,
            variant: "destructive",
          }),
      },
    );
  }

  function handleOrgRoleChange(organizationId: number, orgName: string, userId: number, role: "owner" | "admin" | "member") {
    setOrgRole(
      { organizationId, userId, role },
      {
        onSuccess: () => toast({ title: `Role in ${orgName} updated` }),
        onError: (err) =>
          toast({
            title: "Couldn't change the role",
            description: err instanceof Error && err.message.includes("last owner") ? "An org must keep at least one owner." : undefined,
            variant: "destructive",
          }),
      },
    );
  }

  function handleRoleChange(userId: number, role: "admin" | "member") {
    updateRole(
      { id: userId, data: { role } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListUsersQueryKey() });
          toast({ title: "Role updated" });
        },
        onError: () => toast({ title: "Failed to update role", variant: "destructive" }),
      }
    );
  }

  return (
    <AdminSectionShell
      title="Users"
      scope="platform"
      icon={Users}
      description="Every registered account on the platform, across all organizations."
    >
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Users</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {users?.length ?? 0} registered. Platform admin grants full access to every
            organization and all admin tooling — hand it out sparingly.
          </p>
        </div>

        {usersLoading ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="space-y-1">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-48" />
                </div>
                <Skeleton className="h-8 w-28" />
              </div>
            ))}
          </div>
        ) : users && users.length > 0 ? (
          <div className="divide-y divide-border" data-testid="users-list">
            {users.map((user) => {
              const memberships = membershipsByUser.get(user.id) ?? [];
              return (
                <div key={user.id} className="flex items-center justify-between gap-4 px-5 py-3.5" data-testid={`user-row-${user.id}`}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{user.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                    {memberships.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                        {memberships.map((m) => (
                          <span key={m.orgId} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                            {m.orgName}
                            <Select
                              value={m.role}
                              onValueChange={(val) =>
                                handleOrgRoleChange(m.orgId, m.orgName, user.id, val as "owner" | "admin" | "member")
                              }
                            >
                              <SelectTrigger
                                className="h-6 w-24 text-xs"
                                data-testid={`org-role-select-${user.id}-${m.orgId}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="owner">Owner</SelectItem>
                                <SelectItem value="admin">Admin</SelectItem>
                                <SelectItem value="member">Member</SelectItem>
                              </SelectContent>
                            </Select>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground/80 mt-0.5">No organization</p>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <Select
                      value={user.role}
                      onValueChange={(val) => handleRoleChange(user.id, val as "admin" | "member")}
                      disabled={user.id === me?.id}
                    >
                      <SelectTrigger className="h-8 w-36 text-sm" data-testid={`role-select-${user.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="admin">Platform admin</SelectItem>
                      </SelectContent>
                    </Select>
                    {user.id === me?.id ? (
                      <span className="text-xs text-muted-foreground">(you)</span>
                    ) : (
                      <DangerConfirmDialog
                        testId={`delete-user-${user.id}`}
                        trigger={
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            disabled={deleting}
                            aria-label={`Delete ${user.name}`}
                          >
                            {deleting ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4 text-destructive" />
                            )}
                          </Button>
                        }
                        title={`Delete ${user.name}?`}
                        phrase={user.email}
                        phraseLabel="Type the user's email address to confirm"
                        confirmLabel="Delete user"
                        pending={deleting}
                        onConfirm={(confirm) => handleDelete(user.id, user.name, confirm)}
                        description={
                          <>
                            <p>
                              Their account, sessions and sign-in credentials are removed
                              permanently.
                            </p>
                            {memberships.length > 0 ? (
                              <p>
                                Photos, albums, collections, projects and campaigns they created in{" "}
                                {memberships.map((m) => m.orgName).join(", ")} are kept and handed to
                                another member of each organization — nothing in those libraries is
                                deleted.
                              </p>
                            ) : (
                              <p>They don't belong to any organization.</p>
                            )}
                          </>
                        }
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="px-5 py-10 text-center">
            <p className="text-sm text-muted-foreground">No users yet.</p>
          </div>
        )}
      </div>
    </AdminSectionShell>
  );
}
