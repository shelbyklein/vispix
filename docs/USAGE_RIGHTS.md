# Usage rights (#207)

Vispix records **usage rights** as org-scoped tags on photos (`attribution_tags` / `photo_attribution_tags`): "USA Archery", "Social", and so on. A tag means *your team recorded that this use is allowed*. It is **not** an independent legal verification, and nothing in the product may call it a "clearance".

## States

| Status | When | Shown as |
|---|---|---|
| `not_recorded` | The photo has no rights tag | "Rights not recorded" (amber warning) |
| `recorded` | The photo has one or more rights tags | The tag names, with "Recorded by your team · not a legal clearance" |

`not_recorded` is **unknown**, not "no rights". Absent data always stays unknown; nothing is inferred or backfilled.

The API exposes this as `usageRights: { status, tags: [{ id, name }] }` on photo responses and the MCP as `rightsStatus` alongside `rights`.

## Policy: warning only (decided 2026-10-04)

| Action | Not recorded | Recorded |
|---|---|---|
| Viewing (details, lightbox) | Warning + route to review rights | Tags + "not a legal clearance" |
| Selecting (select mode) | The selection bar counts photos with rights not recorded | — |
| Project export | Confirmation lists them; download allowed; flagged in `usage-rights.json` | Listed as recorded; tags in the manifest |
| Rights changed since shortlisting | Export confirmation and manifest report the change; download allowed | same |
| MCP / agents | Status returned explicitly; nothing hidden unless the caller filters by a rights tag | same |

Nothing is blocked, so there are no override roles. **Hard blocking, override authority and agent refusal rules require a separate, recorded policy decision.**

## Snapshots

- **Shortlist** — `project_photos.rights_snapshot` records the status and tags when a photo is added to a project (`null` for photos added before this existed: "not captured at shortlist time").
- **Export** — the project zip includes `usage-rights.json`: each photo's current status and tags at download time, what changed since it was shortlisted, and `checkedAt`.

Current rights are always re-read at the moment of the action (export), so changes made after shortlisting are caught.

## Next phase (not implemented — do not imply it exists)

Structured restrictions would extend a tag assignment with: restriction type (channel, territory, embargo), expiry date, approver (user + timestamp), and an optional release-document attachment. Expired or restricted assignments would add states (`restricted`, `expired`), and any enforcement would follow the policy decision above.
