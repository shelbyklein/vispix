import { Router, type IRouter } from "express";
import { GetPhotoGraphParams, GetPhotoGraphQueryParams, GetPhotoGraphResponse } from "@workspace/api-zod";
import { requireOrgAuth } from "../middlewares/requireOrg";
import { canSeeHiddenPhotos } from "../lib/capabilities";
import { buildPhotoGraph, DEFAULT_GRAPH_THREADS, GRAPH_THREAD_KINDS, type GraphThreadKind } from "../lib/photoGraph";
import { graphRateLimit } from "../lib/graphRateLimit";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Photo Graph (#202): the threads around one photo. Spec on the issue.
router.get("/photos/:id/graph", requireOrgAuth, graphRateLimit, async (req, res): Promise<void> => {
  const params = GetPhotoGraphParams.safeParse(req.params);
  const query = GetPhotoGraphQueryParams.safeParse(req.query);
  if (!params.success || !Number.isInteger(params.data.id) || params.data.id <= 0) {
    res.status(400).json({ error: "Invalid photo ID" });
    return;
  }
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const { perThread = 6, depth = 1, limit = 80 } = query.data;
  if (![perThread, depth, limit].every(Number.isInteger)) {
    res.status(400).json({ error: "perThread, depth and limit must be whole numbers" });
    return;
  }

  let threads: GraphThreadKind[] = DEFAULT_GRAPH_THREADS;
  if (query.data.threads !== undefined) {
    const asked = [...new Set(query.data.threads.split(",").map((t) => t.trim()).filter(Boolean))];
    const unknown = asked.filter((t) => !(GRAPH_THREAD_KINDS as readonly string[]).includes(t));
    if (asked.length === 0 || unknown.length > 0) {
      res.status(400).json({ error: `Unknown thread kind${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ") || "(none given)"}`, allowed: GRAPH_THREAD_KINDS });
      return;
    }
    threads = GRAPH_THREAD_KINDS.filter((k) => asked.includes(k));
  }

  try {
    const graph = await buildPhotoGraph(params.data.id, {
      organizationId: req.org!.id,
      canSeeHidden: canSeeHiddenPhotos(req),
      threads,
      perThread,
      depth: depth as 1 | 2,
      limit,
    });
    if (!graph) {
      res.status(404).json({ error: "Photo not found" });
      return;
    }
    res.json(GetPhotoGraphResponse.parse(graph));
  } catch (err) {
    // 57014 = query_canceled (statement timeout).
    if ((err as { code?: string })?.code === "57014" || (err as { cause?: { code?: string } })?.cause?.code === "57014") {
      res.status(503).json({ error: "The graph took too long to build", code: "graph_timeout" });
      return;
    }
    logger.error({ err }, "Failed to build photo graph");
    res.status(500).json({ error: "Failed to build photo graph" });
  }
});

export default router;
