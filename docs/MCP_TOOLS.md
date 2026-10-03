# MCP tool schemas (#214)

Version: **`vispix-mcp-tools/1`**. Every read tool returns this version in
`structuredContent.schemaVersion`. The zod shapes in
`artifacts/mcp-server/src/structured.ts` are the source of truth; they're
registered as each tool's MCP `outputSchema`, so clients can read them from
`tools/list`. This document describes the same contract.

Compatibility: tool names, input names and the readable `content` text blocks
are unchanged from before. Structured data is **added** as `structuredContent`
(MCP spec 2025-06-18; `@modelcontextprotocol/sdk` 1.29 supports `outputSchema`
and `structuredContent`, and validates results against the schema server-side).
Clients that ignore `structuredContent` keep working off the text, resource
links and images exactly as before. New inputs are optional with defaults that
preserve prior behavior, except `list_assets` pages at 100 by default (see
below).

All tools are read-only. Ranking, filters, exact lookup and cursors come from
the shared retrieval service (`docs/PHOTO_RETRIEVAL.md`); media links come from
media grants (#204).

## Common shapes

```ts
error:  { code: string, message: string } | null   // set whenever status != "ok"
notes:  string[]                                    // caveats; same text as the readable content
page:   { returned, nextCursor: string | null, exhausted: boolean, limited: boolean, total: number | null }
```

`MediaLink`:

```ts
{
  kind: "thumbnail" | "original",
  url: string,                 // GET it; gateway grants carry no connector credential
  mimeType: string,            // thumbnails: image/jpeg; originals: storage content type, else by extension
  filename: string | null,
  fileSize: number | null,     // bytes, when known (originals)
  expiresAt: string | null,    // ISO-8601 UTC, e.g. "2026-10-01T01:00:00Z"
  grant: "gateway_media_grant" | "signed_storage_url"
}
```

Over the HTTP gateway links are one-object, org-bound, expiring grants
(`gateway_media_grant`, 1 hour). The local stdio server has no gateway, so it
returns ~1 hour signed storage URLs (`signed_storage_url`) and no thumbnail
links. A link is never an MCP credential.

`PhotoItem`:

```ts
{
  id, filename, albumTitle, description,
  width, height, takenAt,                              // null when unknown
  rating:  { average: number | null, count },
  quality: { score: number | null, flaws: string[] },  // AI overall 0-10
  rights:  string[],                                   // usage-rights tags the photo is cleared for
  match:   { type: "exact", fields: ("photo_id" | "filename")[] }
         | { type: "keyword", fields: string[] }
         | { type: "concept", similarity, qualityScore, score }
         | null,                                       // search results only
  thumbnail: MediaLink | null                          // gateway only, when a thumbnail exists
}
```

`images` (every tool that can inline pixels):

```ts
{ requested: boolean, included: number, omitted: number, maxImages: number, maxBytesEach: number }
```

## Inline images

Optional and bounded. `includeImages` (default `true`, as before) turns inline
base64 images on or off. When on, `search_photos` inlines at most `maxImages`
(1-10, default 10) thumbnails, each at most 1.5 MB, and stops once a response
holds about 6 MB of image data. `images.included`/`omitted` report what
happened; omitted photos are still reachable through `thumbnail` links and
`get_photo`. `get_photo` and `get_asset` inline one image (assets: raster files
up to 1.5 MB only; SVG/PDF are download-only).

## Tools

### `search_photos`

Inputs: `query` (string, required), `count` (1-50, default 8, the page size),
`mode` (`concept` default | `combined` | `keyword`), `cursor`, `exclude`,
`minRating`, `minQuality`, `rightsTag`, `person`, `includeImages`, `maxImages`.

Output:

```ts
{
  schemaVersion, notes, error,
  status: "ok" | "unavailable" | "invalid_request",
  results: PhotoItem[],
  page,
  retrieval: { version, mode, embeddingModel, ranking } | null,
  coverage:  { notEmbedded } | null,        // concept: matching photos with no embedding
  degraded:  { reason: "not_configured" | "timeout" | "cancelled" | "provider_error",
               affects: "query" | "exclusions" | "concept" } | null,
  images
}
```

- **Exact lookup.** `mode: "combined"` (or `"keyword"`) treats a query that is
  a photo id (`123`, `#123`, `id:123`) or a filename (case-insensitive, with or
  without a trailing image extension) as an exact lookup. Those photos come
  first, on page one, with `match.type: "exact"`. The default `concept` mode
  does not do exact lookup.
- **Traversal.** Pass `page.nextCursor` back as `cursor`, with the same query,
  mode and filters. Cursors are keyset positions bound to the request, so pages
  have no gaps or duplicates. Stop when `nextCursor` is null; `page.exhausted`
  says there is nothing more, `page.limited` says more exist but concept paging
  stopped at 1,000.
- **Status.** `unavailable` = the embedding provider failed and nothing was
  ranked; it is not an empty library (`degraded.reason` says why). `ok` with
  `degraded.affects: "concept"` = `combined` fell back to literal matches.
  `invalid_request` = an unknown `rightsTag`/`person` name (the message lists
  the organization's own names) or a missing organization scope.
- **Errors** (`isError: true`, `status: "invalid_request"`, `results: []`):
  `invalid_cursor`, `cursor_mismatch` (cursor belongs to another query, filters
  or ranking version; restart from page one), `search_timeout`.

### `get_photo`

Inputs: `id` (int), `includeImages` (default true).

```ts
{
  schemaVersion, notes, error, images,
  status: "ok" | "not_found" | "forbidden",
  photo: (PhotoItem & { fileSize: number | null, original: MediaLink | null }) | null
}
```

`not_found` for any id the connector can't see: one outside its organization
(including another organization's id) or a hidden photo in its own (#218). It
is indistinguishable from an id that does not exist, so it never confirms that
a photo exists. `isError: true`. (`forbidden` is reserved in the schema and not
returned by any read tool today.)

### `list_albums`, `list_people`, `list_usage_rights`

No inputs. Each returns the organization's whole list in one page.

```ts
{ schemaVersion, notes, error, status: "ok", page /* exhausted, nextCursor null */, items: [...] }
// list_albums:        { id, title, photoCount }
// list_people:        { id, name, description, photoCount }
// list_usage_rights:  { id, name, photoCount }
```

### `list_assets`

Inputs: `kind` (`brand` | `reference`), `project` (name; includes global
assets), `name` and `filename` (exact, case-insensitive), `limit` (1-200,
default 100), `cursor`.

```ts
{
  schemaVersion, notes, error,
  status: "ok" | "invalid_request",
  items: AssetItem[],   // { id, kind, name, variant, notes, projectName (null = global),
                        //   filename, mimeType, fileSize, isPrimary }
  page
}
```

Order is `kind, name, id`; the cursor is bound to the filters. Errors:
`invalid_cursor`, `cursor_mismatch`. An unknown `project` returns `ok`, no
items, and the available names in `notes`. Behavior change: previously this
returned every asset; now it returns the first 100 plus a cursor.

### `get_asset`

Inputs: `id`, `includeImages` (default true).

```ts
{
  schemaVersion, notes, error, images,
  status: "ok" | "not_found",
  asset: (AssetItem & { original: MediaLink | null }) | null
}
```

Another organization's asset id is `not_found` (`isError: true`).

## Writes (not enabled)

**Proposal only. Nothing here is implemented, and enabling it needs an owner
decision.** Issue #214 also covers project listing and shortlist
save/add/remove. These are blocked on a token-approval policy; no write tool,
token scope or permission change ships with the read tools above.

Intended model, for the owner to accept, change or reject:

- Tokens gain an explicit capability set, `scopes: ["read"]` by default.
  Existing tokens migrate to `["read"]` and stay read-only. A write scope
  (for example `shortlist:write`) is granted only by an authorized org
  owner/admin action in the app, per token, never by the agent itself.
- Write tools would be listed only for tokens holding the scope, and each call
  would still check the acting user's role (ROLES, #218), project membership
  and the selection rules from SELECT (#211), reusing those services.
- Mutations take a caller-supplied idempotency key, return per-item outcomes
  (`added`, `already_present`, `not_found`, `forbidden`), and record the token
  and key in an audit trail. Another organization's ids are `not_found`.
- Out of scope: delete, publish, external messaging, scope escalation.
- Open decisions: scope names and granularity (per project or org-wide), who
  may mint write tokens, token expiry for write scopes, and whether a write
  scope is allowed on the shared env-var token at all.
