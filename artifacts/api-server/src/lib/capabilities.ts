import type { Request } from "express";

// One capability matrix for organization content (#218), decided 2026-10-01:
//
//   creator/uploader     edit and delete their own items; set usage rights on
//                        photos they uploaded
//   org owner/admin      manage all of their organization's content (photos
//                        incl. bulk hide/delete, albums, projects, collections,
//                        assets, rights tags) and see hidden photos
//   member               create, view and rate; manage only their own items
//   platform admin       everything (users.role = "admin")
//   MCP connector        read-only (unchanged)
//
// Tenant scope is separate and always enforced by the caller's queries: these
// helpers only answer "may this person act on an item of the active org".

/** A platform admin, or an owner/admin of the active organization. */
export function isOrgManager(req: Pick<Request, "dbUser" | "orgRole">): boolean {
  return req.dbUser?.role === "admin" || req.orgRole === "owner" || req.orgRole === "admin";
}

/** May change or delete an item of the active org: its creator, or an org manager. */
export function canManageItem(req: Pick<Request, "dbUser" | "orgRole">, creatorId: number | null | undefined): boolean {
  return (creatorId != null && creatorId === req.dbUser?.id) || isOrgManager(req);
}

/** May see (and unhide) the active org's hidden photos. */
export function canSeeHiddenPhotos(req: Pick<Request, "dbUser" | "orgRole">): boolean {
  return isOrgManager(req);
}

/** May set usage rights on one photo: org managers and the photo's uploader. */
export function canSetPhotoRights(req: Pick<Request, "dbUser" | "orgRole">, uploaderId: number | null | undefined): boolean {
  return canManageItem(req, uploaderId);
}
