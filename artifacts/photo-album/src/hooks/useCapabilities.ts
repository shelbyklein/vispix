import { useGetMe } from "@workspace/api-client-react";
import { useOrg } from "@/contexts/OrgContext";

/**
 * What the signed-in person may do in the active organization — the same
 * matrix the API enforces (#218, api-server lib/capabilities.ts). The server
 * stays authoritative; this only decides which controls to offer.
 */
export function useCapabilities() {
  const { data: me } = useGetMe();
  const { activeOrg } = useOrg();
  const isOrgManager = me?.role === "admin" || activeOrg?.role === "owner" || activeOrg?.role === "admin";
  const canManageItem = (creatorId: number | null | undefined) =>
    !!me && ((creatorId != null && creatorId === me.id) || isOrgManager);
  return {
    me,
    /** Platform admin, or owner/admin of the active org. */
    isOrgManager,
    /** Edit/delete an item: its creator or an org manager. */
    canManageItem,
    /** See and unhide hidden photos. */
    canSeeHidden: isOrgManager,
    /** Set usage rights on a photo: its uploader or an org manager. */
    canSetPhotoRights: canManageItem,
  };
}
