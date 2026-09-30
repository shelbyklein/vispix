import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

// One org the current user belongs to, with their role in it (issue #113).
export type MyOrganization = {
  id: number;
  name: string;
  slug: string;
  role: string; // "owner" | "admin" | "member"
  logoUrl: string | null;
};

const MY_ORGS_KEY = ["organizations", "mine"] as const;

export function useMyOrganizations() {
  return useQuery({
    queryKey: MY_ORGS_KEY,
    queryFn: () => customFetch<MyOrganization[]>("/api/organizations"),
    staleTime: 5 * 60 * 1000,
    // OrgProvider mounts above the auth gate, so this can fire while signed out
    // (401) — don't retry that.
    retry: false,
  });
}

// Create a new org (the caller becomes owner). Used by the "no org yet" screen.
export function useCreateOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      customFetch<MyOrganization>("/api/organizations", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MY_ORGS_KEY }),
  });
}

// Persist the user's sticky active org server-side. The header the client sends
// is the source of truth per-request; this makes the choice survive a fresh
// session with no stored preference.
export function useSwitchOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (organizationId: number) =>
      customFetch<MyOrganization>("/api/organizations/switch", {
        method: "POST",
        body: JSON.stringify({ organizationId }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MY_ORGS_KEY }),
  });
}

// --- Active org details / settings (Phase 4d) ---

export type OrgDetails = {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  role: string;
  memberCount: number;
  logoUrl: string | null;
};

const CURRENT_ORG_KEY = ["organizations", "current"] as const;

export function useOrgDetails() {
  return useQuery({
    queryKey: CURRENT_ORG_KEY,
    queryFn: () => customFetch<OrgDetails>("/api/organizations/current"),
  });
}

export function useUpdateOrg() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; description?: string | null; logoKey?: string | null }) =>
      customFetch<OrgDetails>("/api/organizations/current", {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      // Refresh the details view and the switcher's org list (name may change).
      queryClient.invalidateQueries({ queryKey: CURRENT_ORG_KEY });
      queryClient.invalidateQueries({ queryKey: MY_ORGS_KEY });
    },
  });
}

// --- Member + invite management (Phase 4c) ---

export type OrgMember = {
  userId: number;
  name: string;
  email: string;
  role: string;
  joinedAt: string;
};
export type OrgInvite = { id: number; email: string; role: string; createdAt: string };
/** The create response also says whether the invite email went out. */
export type CreatedOrgInvite = OrgInvite & { emailSent: boolean };
export type OrgRole = "owner" | "admin" | "member";

const MEMBERS_KEY = ["organizations", "members"] as const;
const INVITES_KEY = ["organizations", "invites"] as const;

export function useOrgMembers() {
  return useQuery({
    queryKey: MEMBERS_KEY,
    queryFn: () => customFetch<OrgMember[]>("/api/organizations/members"),
  });
}

export function useOrgInvites() {
  return useQuery({
    queryKey: INVITES_KEY,
    queryFn: () => customFetch<OrgInvite[]>("/api/organizations/invites"),
  });
}

export function useCreateOrgInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; role?: OrgRole }) =>
      customFetch<CreatedOrgInvite>("/api/organizations/invites", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: INVITES_KEY }),
  });
}

export function useDeleteOrgInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/organizations/invites/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: INVITES_KEY }),
  });
}

export function useUpdateOrgMemberRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: number; role: OrgRole }) =>
      customFetch<void>(`/api/organizations/members/${input.userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role: input.role }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MEMBERS_KEY }),
  });
}

export function useRemoveOrgMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) =>
      customFetch<void>(`/api/organizations/members/${userId}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MEMBERS_KEY }),
  });
}
