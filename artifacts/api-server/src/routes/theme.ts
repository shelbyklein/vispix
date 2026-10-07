import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, appSettingsTable, APP_SETTINGS_SINGLETON_ID } from "@workspace/db";
import { DEFAULT_THEME, PlatformThemeSchema, themeToCss, type PlatformThemeState } from "@workspace/api-zod/theme";
import { requireAdmin } from "../middlewares/requireAuth";
import { loadAppSettings } from "../lib/aiProviders";
import { logger } from "../lib/logger";

// Platform theme (#253). The design tokens a superadmin edits live; stored on
// the app_settings singleton and served as a public stylesheet.
const router: IRouter = Router();

const EMPTY_CSS = "/* built-in theme */\n";

async function loadState(): Promise<PlatformThemeState> {
  const settings = await loadAppSettings();
  return {
    theme: settings.theme ?? null,
    defaults: DEFAULT_THEME,
    updatedAt: settings.themeUpdatedAt ? settings.themeUpdatedAt.toISOString() : null,
  };
}

// Public: the sign-in page needs it too. No-cache + ETag so every load
// revalidates cheaply and a saved change shows on the next page load.
router.get("/theme.css", async (req, res): Promise<void> => {
  const settings = await loadAppSettings();
  const parsed = settings.theme ? PlatformThemeSchema.safeParse(settings.theme) : null;
  const css = parsed?.success ? themeToCss(parsed.data) : EMPTY_CSS;
  const etag = `"${createHash("sha256").update(css).digest("hex").slice(0, 32)}"`;
  res.set({ "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache", ETag: etag });
  if (req.headers["if-none-match"]?.split(",").some((t) => t.trim() === etag)) {
    res.status(304).end();
    return;
  }
  res.send(css);
});

router.get("/platform/theme", requireAdmin, async (_req, res): Promise<void> => {
  res.json(await loadState());
});

router.put("/platform/theme", requireAdmin, async (req, res): Promise<void> => {
  const body = PlatformThemeSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid theme", issues: body.error.issues });
    return;
  }
  await loadAppSettings();
  await db
    .update(appSettingsTable)
    .set({ theme: body.data, themeUpdatedAt: new Date() })
    .where(eq(appSettingsTable.id, APP_SETTINGS_SINGLETON_ID));
  logger.info({ userId: req.dbUser?.id }, "Platform theme saved");
  res.json(await loadState());
});

router.delete("/platform/theme", requireAdmin, async (req, res): Promise<void> => {
  await loadAppSettings();
  await db
    .update(appSettingsTable)
    .set({ theme: null, themeUpdatedAt: new Date() })
    .where(eq(appSettingsTable.id, APP_SETTINGS_SINGLETON_ID));
  logger.info({ userId: req.dbUser?.id }, "Platform theme reset to built-in");
  res.json(await loadState());
});

export default router;
