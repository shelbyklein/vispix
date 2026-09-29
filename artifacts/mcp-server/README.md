# @workspace/mcp-server

MCP server exposing the Vispix photo library to AI clients, so a model
given marketing copy can pull candidate photos that fit each described concept
and judge them visually (results include inline thumbnails).

It talks to the database and object storage directly, reusing the api-server's
own libs (Vertex text embedding, the iterative HNSW vector ranking, GCS URL
signing) — ranking behaviour is identical to the app's semantic search. It
reads the same root `.env` as the api-server; whichever `DATABASE_URL` /
`GCS_ENDPOINT` that file points at is the library it serves.

## Tools

| Tool | What it does |
| --- | --- |
| `search_photos(query, count, exclude?, minRating?, rightsTag?, includeImages?)` | Semantic ranking with optional rating / usage-rights filters; inline thumbnails for the top results |
| `get_photo(id)` | Full metadata, thumbnail, and a ~1h download link for the full-resolution file (see [Media links](#media-links)) |
| `list_albums` | Albums with photo counts |
| `list_usage_rights` | Attribution / usage-rights tags with cleared-photo counts |
| `list_assets(kind?, project?)` | Asset library: brand assets (logos to embed) and reference works (past output to match); project filter includes global assets |
| `get_asset(id)` | One asset's metadata, an inline preview for raster images, and a download link for the original file |

## Running

```sh
pnpm --filter @workspace/mcp-server run start
```

stdio transport — stdout is the protocol channel. The entry point silences the
api-server libs' pino logging before they load; keep it that way.

## Client setup

**Claude Code**: the repo's `.mcp.json` registers the server automatically for
sessions in this checkout.

**Claude Desktop** (`claude_desktop_config.json`) — same launcher, run from a
checkout (`--dir` keeps it cwd-independent; swap in the dev worktree path to
serve the dev database instead):

```json
{
  "mcpServers": {
    "vispix": {
      "command": "pnpm",
      "args": [
        "--dir", "C:/Vibes/Targetvision/Targetvision",
        "--silent", "--filter", "@workspace/mcp-server", "run", "start"
      ]
    }
  }
}
```

## Remote access (off-machine clients)

`start:http` runs the same tools over streamable HTTP (port `MCP_HTTP_PORT`,
default 8086), exposed publicly via the cloudflared tunnel:

```sh
pnpm run mcp:http   # from the repo root; the prod launcher also starts it
```

Requires `MCP_AUTH_TOKEN` in `.env` (>= 24 chars; `openssl rand -hex 32`) —
the server refuses to start without it, since the tunnel makes it public.
Auth is accepted two ways:

- `Authorization: Bearer <token>` header — e.g. Claude Code on another machine:
  `claude mcp add --scope user --transport http vispix
  https://mcp.vispix.dev/mcp --header "Authorization: Bearer <token>"`
- Token as the first URL path segment — for clients whose connector UI only
  accepts a URL (claude.ai custom connectors):
  `https://mcp.vispix.dev/<token>/mcp`.
  The URL is the secret; treat it like a password.
- ChatGPT / OpenAI: same token-in-URL form — in ChatGPT go to Settings →
  Apps & Connectors → Create, paste
  `https://mcp.vispix.dev/<token>/mcp` as the MCP server URL,
  and pick authentication "None" (the token rides in the URL; ChatGPT's
  connector UI has no custom-header option).

`GET /healthz` is unauthenticated; `GET /media/<grant>` is authorized by the
grant itself (below). Everything else needs a connector token.

### Media links

How `get_photo`, `get_asset` and `search_photos` hand out file links depends on
the transport:

- **stdio** (local): a GCS/fake-gcs signed storage URL, valid ~1h. It only
  resolves where the storage endpoint is reachable, which is why remote clients
  get gateway links instead.
- **HTTP gateway** (#204): a media grant,
  `<MCP_PUBLIC_URL>/media/<claims>.<signature>`. A grant opens exactly one
  object and representation (photo original, photo thumbnail, or asset
  original) in one organization, for one hour; the response states the expiry
  (`expires 2026-09-29T01:00:00Z`). It never contains the connector token, and
  it cannot call MCP tools or open anything else. Each fetch re-checks the
  connector token that minted it, so revoking a token in
  `/admin/mcp-tokens` kills its outstanding links immediately. Expired links
  return `410`; tampered, revoked or foreign ones `403`. Media responses are
  `Cache-Control: private, no-store`.

Connector tokens and media grants are different things: a **connector token**
(`tvmcp_…`, or `MCP_AUTH_TOKEN`) is a long-lived credential to treat like a
password; a **media grant** is a disposable link that is safe to paste into a
chat or document for its hour.

**Signing key.** Grants are HMAC-SHA256 signed with a key derived (HKDF) from
`MCP_MEDIA_SIGNING_KEY` (≥ 32 chars) if set, otherwise from
`BETTER_AUTH_SECRET`, so existing deployments need no new config. With
neither, a per-process random key is used and links end on restart. The grant's
audience is `MCP_PUBLIC_URL`, so dev-minted links never open prod media even
though dev copies prod's `BETTER_AUTH_SECRET`. To rotate: set the new
`MCP_MEDIA_SIGNING_KEY`, put the old secret in
`MCP_MEDIA_SIGNING_KEY_PREVIOUS` (comma-separated; verify-only), restart, and
drop the previous value after an hour. Rotating without a previous value
invalidates every outstanding link at once.

**Retired links.** Before #204 the gateway returned
`<MCP_PUBLIC_URL>/<token>/photo/:id/original` (and `/thumbnail`,
`/asset/:id/original`): the connector token rode in every link. These are no
longer issued, and a token-in-path request for anything but `/mcp` now gets
`410 Gone` — call the tool again for a fresh link. Those links were only ever
advertised as valid ~1h. Connector URLs (`<MCP_PUBLIC_URL>/<token>/mcp`) are
unchanged. Clients that send `Authorization: Bearer` may still fetch
`/photo/:id/original`, `/photo/:id/thumbnail` and `/asset/:id/original`
directly with that header. A connector token that was ever pasted in a link
should be revoked and replaced in `/admin/mcp-tokens`.

Tunnel side: a Cloudflare Zero Trust public hostname must map
`mcp.vispix.dev` → `http://<host>:8086` (the tunnel is
remotely managed, so this lives in the dashboard, not a local config).
