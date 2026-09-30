import { useState } from "react";
import {
  useGetMe,
  useOrgMembers,
  useOrgInvites,
  useCreateOrgInvite,
  useDeleteOrgInvite,
  useRemoveOrgMember,
  useUpdateOrgMemberRole,
  type OrgMember,
  type OrgInvite,
  type OrgRole,
} from "@workspace/api-client-react";
import { AdminSectionShell } from "@/components/admin/AdminSectionShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Users, Loader2, Plus, Trash2, Mail } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/format-date";
import { useOrg } from "@/contexts/OrgContext";

const ROLES: OrgRole[] = ["owner", "admin", "member"];

function RoleSelect({ value, onChange, disabled }: { value: string; onChange: (r: OrgRole) => void; disabled?: boolean }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as OrgRole)}
      disabled={disabled}
      className="h-8 rounded-md border border-input bg-background px-2 text-xs disabled:opacity-50"
      data-testid="member-role-select"
    >
      {ROLES.map((r) => (
        <option key={r} value={r}>{r}</option>
      ))}
    </select>
  );
}

function MemberRow({ member, canManage }: { member: OrgMember; canManage: boolean }) {
  const { toast } = useToast();
  const { mutate: updateRole, isPending: updating } = useUpdateOrgMemberRole();
  const { mutate: removeMember, isPending: removing } = useRemoveOrgMember();

  return (
    <div className="flex items-center gap-3 px-5 py-3" data-testid={`member-row-${member.userId}`}>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{member.name}</p>
        <p className="text-xs text-muted-foreground truncate">
          {member.email} · joined {formatDate(member.joinedAt)}
        </p>
      </div>
      {canManage ? (
        <RoleSelect
          value={member.role}
          disabled={updating}
          onChange={(role) =>
            updateRole(
              { userId: member.userId, role },
              {
                onSuccess: () => toast({ title: `Role updated to ${role}` }),
                onError: () => toast({ title: "Couldn't update role", variant: "destructive" }),
              },
            )
          }
        />
      ) : (
        <span className="text-xs text-muted-foreground px-2">{member.role}</span>
      )}
      {canManage && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" disabled={removing} aria-label={`Remove ${member.name}`}>
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {member.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                They lose access to this organization immediately. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive hover:bg-destructive/90"
                onClick={() =>
                  removeMember(member.userId, {
                    onSuccess: () => toast({ title: `Removed ${member.name}` }),
                    onError: () => toast({ title: "Couldn't remove member", variant: "destructive" }),
                  })
                }
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

function InviteRow({ invite, onRevoke, revoking }: { invite: OrgInvite; onRevoke: (id: number) => void; revoking: boolean }) {
  return (
    <div className="flex items-center gap-3 px-5 py-3" data-testid={`invite-row-${invite.id}`}>
      <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground truncate">{invite.email}</p>
        <p className="text-xs text-muted-foreground">
          {invite.role} · invited {formatDate(invite.createdAt)} · joins when they next sign in
        </p>
      </div>
      <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" disabled={revoking} onClick={() => onRevoke(invite.id)} aria-label="Revoke invite">
        <Trash2 className="h-4 w-4 text-destructive" />
      </Button>
    </div>
  );
}

export default function AdminOrgMembersPage() {
  const { toast } = useToast();
  const { activeOrg } = useOrg();
  const { data: me } = useGetMe();
  const { data: members, isLoading: membersLoading } = useOrgMembers();
  const { data: invites, isLoading: invitesLoading } = useOrgInvites();
  const { mutate: createInvite, isPending: inviting } = useCreateOrgInvite();
  const { mutate: revokeInvite, isPending: revoking } = useDeleteOrgInvite();

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("member");

  // Owner/admin of the active org, or an instance superadmin, may manage.
  const canManage = me?.role === "admin" || activeOrg?.role === "owner" || activeOrg?.role === "admin";

  function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    const value = email.trim();
    if (!value) return;
    createInvite(
      { email: value, role },
      {
        onSuccess: (invite) => {
          setEmail("");
          // The invite stands even when the email fails — say so, so the
          // inviter can let the person know another way.
          if (invite.emailSent === false) {
            toast({
              title: `Invited ${value}, but the email couldn't be sent`,
              description: "Let them know to sign in or sign up at vispix.dev with this address — they'll join automatically.",
              variant: "destructive",
            });
          } else {
            toast({ title: `Invited ${value}` });
          }
        },
        onError: () => toast({ title: "Couldn't send invite", variant: "destructive" }),
      },
    );
  }

  return (
    <AdminSectionShell
      title="Organization Members"
      icon={Users}
      description={`People in ${activeOrg?.name ?? "this organization"}. Invite a teammate by email — they join automatically when they next sign in.`}
    >
      <div className="space-y-6 max-w-2xl">
        {canManage && (
          <form onSubmit={handleInvite} className="flex flex-wrap gap-2" data-testid="invite-form">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@example.com"
              className="h-9 flex-1 min-w-48"
              disabled={inviting}
              data-testid="invite-email"
            />
            <RoleSelect value={role} onChange={setRole} disabled={inviting} />
            <Button type="submit" size="sm" className="h-9 gap-1.5" disabled={inviting || !email.trim()} data-testid="invite-submit">
              {inviting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Invite
            </Button>
          </form>
        )}

        {!invitesLoading && invites && invites.length > 0 && (
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border text-sm font-medium text-foreground">Pending invites</div>
            <div className="divide-y divide-border">
              {invites.map((invite) => (
                <InviteRow
                  key={invite.id}
                  invite={invite}
                  revoking={revoking}
                  onRevoke={(id) =>
                    revokeInvite(id, {
                      onSuccess: () => toast({ title: "Invite revoked" }),
                      onError: () => toast({ title: "Couldn't revoke invite", variant: "destructive" }),
                    })
                  }
                />
              ))}
            </div>
          </div>
        )}

        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b border-border text-sm font-medium text-foreground">Members</div>
          {membersLoading ? (
            <div className="flex items-center gap-1.5 px-5 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading members…
            </div>
          ) : (
            <div className="divide-y divide-border" data-testid="members-list">
              {(members ?? []).map((member) => (
                <MemberRow key={member.userId} member={member} canManage={!!canManage} />
              ))}
            </div>
          )}
        </div>
      </div>
    </AdminSectionShell>
  );
}
