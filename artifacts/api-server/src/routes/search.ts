import { Router, type IRouter, type Response } from "express";
import { SearchPhotosPagedResponse, SemanticSearchPhotosResponse, RetrievePhotosResponse } from "@workspace/api-zod";
import { requireOrgAuth } from "../middlewares/requireOrg";
import { buildPhotosResponse } from "../lib/photoHelpers";
import { parseSearchFilters } from "../lib/searchFilters";
import { retrievePhotos, RetrievalError, MAX_PAGE_SIZE } from "../lib/photoRetrieval";

const router: IRouter = Router();

// Photo search routes are adapters over the shared retrieval service (#213,
// docs/PHOTO_RETRIEVAL.md): /search (keyword, offset pages) and
// /search/semantic (concept, topK array) keep their response shapes;
// /search/photos exposes the full contract.

function retrievalErrorStatus(err: unknown): number | null {
  if (!(err instanceof RetrievalError)) return null;
  return err.code === "search_timeout" ? 503 : err.code === "invalid_scope" ? 500 : 400;
}

/** Aborts the provider call when the client goes away before we answer. */
function abortOnClientClose(res: Response): AbortSignal {
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) ac.abort();
  });
  return ac.signal;
}

function intParam(raw: unknown, fallback: number): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  return Number.isInteger(n) ? n : fallback;
}

router.get("/search", requireOrgAuth, async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) {
    res.json(SearchPhotosPagedResponse.parse({ photos: [], hasMore: false }));
    return;
  }
  const parsed = parseSearchFilters(req.query as Record<string, unknown>);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { includeHidden, exclude, ...filters } = parsed.filters;
  try {
    const result = await retrievePhotos({
      organizationId: req.org!.id,
      canSeeHidden: req.dbUser!.role === "admin" && includeHidden,
      mode: "keyword",
      text: q,
      exclude,
      filters,
      limit: Math.min(Math.max(intParam(req.query.limit, 48), 1), 200),
      offset: Math.max(intParam(req.query.offset, 0), 0),
    });
    const photos = await buildPhotosResponse(result.items.map((i) => i.photoId), req.org!.id, req.dbUser?.id);
    res.json(SearchPhotosPagedResponse.parse({ photos, hasMore: result.page.nextCursor != null }));
  } catch (err) {
    const status = retrievalErrorStatus(err);
    if (status == null) throw err;
    res.status(status).json({ error: (err as RetrievalError).message, code: (err as RetrievalError).code });
  }
});

router.get("/search/semantic", requireOrgAuth, async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) {
    res.json(SemanticSearchPhotosResponse.parse([]));
    return;
  }
  const parsed = parseSearchFilters(req.query as Record<string, unknown>);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { includeHidden, exclude, ...filters } = parsed.filters;
  const topKRaw = intParam(req.query.topK, 30);
  try {
    const result = await retrievePhotos({
      organizationId: req.org!.id,
      canSeeHidden: req.dbUser!.role === "admin" && includeHidden,
      mode: "concept",
      text: q,
      exclude,
      filters,
      limit: topKRaw > 0 ? Math.min(topKRaw, 100) : 30,
      signal: abortOnClientClose(res),
    });
    // The array response can't carry states; headers say when nothing was
    // ranked because the embedding provider was unavailable.
    res.setHeader("X-Search-Status", result.status);
    if (result.degraded) res.setHeader("X-Search-Degraded", `${result.degraded.affects}:${result.degraded.reason}`);
    const photos = await buildPhotosResponse(result.items.map((i) => i.photoId), req.org!.id, req.dbUser?.id);
    res.json(SemanticSearchPhotosResponse.parse(photos));
  } catch (err) {
    const status = retrievalErrorStatus(err);
    if (status == null) throw err;
    res.status(status).json({ error: (err as RetrievalError).message, code: (err as RetrievalError).code });
  }
});

router.get("/search/photos", requireOrgAuth, async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const mode = req.query.mode ?? "combined";
  if (mode !== "combined" && mode !== "concept" && mode !== "keyword") {
    res.status(400).json({ error: "mode must be combined, concept or keyword", code: "invalid_request" });
    return;
  }
  const parsed = parseSearchFilters(req.query as Record<string, unknown>);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error, code: "invalid_request" });
    return;
  }
  const { includeHidden, exclude, ...filters } = parsed.filters;
  try {
    const result = await retrievePhotos({
      organizationId: req.org!.id,
      canSeeHidden: req.dbUser!.role === "admin" && includeHidden,
      mode,
      text: q,
      exclude,
      filters,
      limit: Math.min(Math.max(intParam(req.query.limit, 30), 1), MAX_PAGE_SIZE),
      cursor: typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : null,
      signal: abortOnClientClose(res),
    });
    const photos = await buildPhotosResponse(result.items.map((i) => i.photoId), req.org!.id, req.dbUser?.id);
    const byId = new Map(photos.flatMap((p) => (p ? [[p.id, p] as const] : [])));
    const { items, ...rest } = result;
    res.json(
      RetrievePhotosResponse.parse({
        ...rest,
        items: items.filter((i) => byId.has(i.photoId)).map((i) => ({ photo: byId.get(i.photoId), match: i.match })),
      }),
    );
  } catch (err) {
    const status = retrievalErrorStatus(err);
    if (status == null) throw err;
    res.status(status).json({ error: (err as RetrievalError).message, code: (err as RetrievalError).code });
  }
});

export default router;
