import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../auth", () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get("x-test-auth-user");
        return id ? { user: { id, email: id, name: id, emailVerified: true } } : null;
      },
    },
    handler: async () => new Response(null, { status: 404 }),
  },
}));
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { COLOR_TOKENS, DEFAULT_THEME, PlatformThemeSchema, googleFontsUrl, themeToCss, type PlatformTheme, type PlatformThemeState } from "@workspace/api-zod/theme";
import app from "../../app";
import { db, pool, appSettingsTable, APP_SETTINGS_SINGLETON_ID } from "@workspace/db";
import { resetDb, createUser, createOrganization, addOrganizationMember } from "./testDb";

type U = { id: number; authUserId: string };
let server: Server;
let base: string;
let platform: U;
let owner: U;
let member: U;

beforeAll(async () => {
  await resetDb();
  await db.update(appSettingsTable).set({ theme: null, themeUpdatedAt: null }).where(eq(appSettingsTable.id, APP_SETTINGS_SINGLETON_ID));
  const org = await createOrganization({ name: "Theme Org" });
  platform = await createUser({ name: "platform", role: "admin" });
  owner = await createUser({ name: "owner" });
  member = await createUser({ name: "member" });
  await addOrganizationMember(org.id, platform.id, "member");
  await addOrganizationMember(org.id, owner.id, "owner");
  await addOrganizationMember(org.id, member.id, "member");
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

function req(as: U | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(as ? { "x-test-auth-user": as.authUserId } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const custom = (): PlatformTheme => ({
  ...structuredClone(DEFAULT_THEME),
  light: { ...DEFAULT_THEME.light, primary: "12 80% 40%" },
  fonts: { body: "Inter", heading: "Lora" },
  radius: 0.75,
});

const EMPTY = "/* built-in theme */\n";

describe("platform theme (#253)", () => {
  it("serves an empty stylesheet by default, with no auth", async () => {
    const res = await req(null, "GET", "/theme.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe(EMPTY);
  });

  it("rejects non-superadmins on every platform/theme method", async () => {
    for (const who of [member, owner]) {
      expect((await req(who, "GET", "/platform/theme")).status).toBe(403);
      expect((await req(who, "PUT", "/platform/theme", custom())).status).toBe(403);
      expect((await req(who, "DELETE", "/platform/theme")).status).toBe(403);
    }
    expect((await req(null, "GET", "/platform/theme")).status).toBe(401);
  });

  it("returns defaults and no theme before anything is saved", async () => {
    const res = await req(platform, "GET", "/platform/theme");
    expect(res.status).toBe(200);
    const state = (await res.json()) as PlatformThemeState;
    expect(state.theme).toBeNull();
    expect(state.updatedAt).toBeNull();
    expect(state.defaults).toEqual(DEFAULT_THEME);
  });

  it("rejects invalid bodies with 400", async () => {
    const badHsl = custom();
    badHsl.light.primary = "blue";
    expect((await req(platform, "PUT", "/platform/theme", badHsl)).status).toBe(400);
    const badFont = { ...custom(), fonts: { body: "Comic Sans", heading: "Lora" } };
    expect((await req(platform, "PUT", "/platform/theme", badFont)).status).toBe(400);
    for (const adobeFontsProject of ["ABC1DEF", "short", "has space", "toolongtoolongtoolong", "a\"b;c1234"]) {
      expect((await req(platform, "PUT", "/platform/theme", { ...custom(), adobeFontsProject })).status, adobeFontsProject).toBe(400);
    }
    expect((await req(platform, "PUT", "/platform/theme", { ...custom(), headingWeight: 650 })).status).toBe(400);
    expect((await req(platform, "PUT", "/platform/theme", { ...custom(), buttonWeight: 1000 })).status).toBe(400);
    const res = await req(platform, "PUT", "/platform/theme", { ...custom(), radius: 5 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
    expect(await (await req(null, "GET", "/theme.css")).text()).toBe(EMPTY);
  });

  it("saves a theme, serves it with an ETag, honours If-None-Match, and resets", async () => {
    const theme = custom();
    const put = await req(platform, "PUT", "/platform/theme", theme);
    expect(put.status).toBe(200);
    const state = (await put.json()) as PlatformThemeState;
    expect(state.theme).toEqual(theme);
    expect(state.updatedAt).toBeTruthy();

    const css = await req(null, "GET", "/theme.css");
    expect(css.status).toBe(200);
    const body = await css.text();
    expect(body).toContain("--primary: 12 80% 40%;");
    expect(body).toContain(`@import url("${googleFontsUrl(theme.fonts)}");`);
    const etag = css.headers.get("etag");
    expect(etag).toMatch(/^"[^"]+"$/);

    const again = await req(null, "GET", "/theme.css", undefined, { "if-none-match": etag! });
    expect(again.status).toBe(304);

    const del = await req(platform, "DELETE", "/platform/theme");
    expect(del.status).toBe(200);
    const reset = (await del.json()) as PlatformThemeState;
    expect(reset.theme).toBeNull();
    expect(reset.updatedAt).toBeTruthy();

    const empty = await req(null, "GET", "/theme.css", undefined, { "if-none-match": etag! });
    expect(empty.status).toBe(200);
    expect(await empty.text()).toBe(EMPTY);
  });
});

describe("theme contract (rebrand)", () => {
  // A theme as saved before button tokens, weights and the Adobe project existed.
  const oldTheme = () => {
    const t = structuredClone(DEFAULT_THEME) as unknown as Record<string, any>;
    for (const mode of ["light", "dark"]) {
      delete t[mode].button;
      delete t[mode]["button-foreground"];
      t[mode].primary = mode === "light" ? "222 99% 51%" : "222 100% 62%";
      t[mode]["primary-foreground"] = "0 0% 100%";
    }
    delete t.headingWeight;
    delete t.buttonWeight;
    delete t.adobeFontsProject;
    t.fonts = { body: "Poppins", heading: "Playfair Display" };
    return t;
  };

  it("parses an old saved theme: defaults applied, button falls back to primary", () => {
    const parsed = PlatformThemeSchema.parse(oldTheme());
    expect(parsed.headingWeight).toBe(DEFAULT_THEME.headingWeight);
    expect(parsed.buttonWeight).toBe(DEFAULT_THEME.buttonWeight);
    expect(parsed.adobeFontsProject).toBeNull();
    expect(parsed.light.button).toBe("222 99% 51%");
    expect(parsed.light["button-foreground"]).toBe("0 0% 100%");
    expect(parsed.dark.button).toBe("222 100% 62%");
  });

  it("keeps an explicit button color when present", () => {
    const t = oldTheme();
    t.light.button = "10 50% 50%";
    expect(PlatformThemeSchema.parse(t).light.button).toBe("10 50% 50%");
  });

  it("serves and returns an old saved theme in full", async () => {
    await db.update(appSettingsTable).set({ theme: oldTheme() as unknown as PlatformTheme, themeUpdatedAt: new Date() }).where(eq(appSettingsTable.id, APP_SETTINGS_SINGLETON_ID));
    const state = (await (await req(platform, "GET", "/platform/theme")).json()) as PlatformThemeState;
    expect(state.theme?.light.button).toBe("222 99% 51%");
    expect(state.theme?.buttonWeight).toBe(400);
    const css = await (await req(null, "GET", "/theme.css")).text();
    expect(css).toContain("--button: 222 99% 51%;");
    expect(css).toContain("--heading-weight: 600;");
    await req(platform, "DELETE", "/platform/theme");
  });

  it("accepts and saves a valid Adobe Fonts project", async () => {
    const theme = { ...custom(), adobeFontsProject: "abc1def" };
    const put = await req(platform, "PUT", "/platform/theme", theme);
    expect(put.status).toBe(200);
    const css = await (await req(null, "GET", "/theme.css")).text();
    expect(css).toContain('@import url("https://use.typekit.net/abc1def.css");');
    await req(platform, "DELETE", "/platform/theme");
  });

  it("themeToCss emits the typekit import only when a project is set, before the Google import", () => {
    const without = themeToCss({ ...DEFAULT_THEME, adobeFontsProject: null });
    expect(without).not.toContain("typekit");
    const withProject = themeToCss({ ...DEFAULT_THEME, adobeFontsProject: "abc1def" });
    const kit = withProject.indexOf("use.typekit.net/abc1def.css");
    expect(kit).toBeGreaterThan(-1);
    expect(kit).toBeLessThan(withProject.indexOf("fonts.googleapis.com"));
  });

  it("themeToCss emits weight vars, the button tokens and the Sofia stack", () => {
    const css = themeToCss({ ...DEFAULT_THEME, headingWeight: 700, buttonWeight: 500 });
    expect(css).toContain("--heading-weight: 700;");
    expect(css).toContain("--button-weight: 500;");
    expect(css).toContain("--button: 211.2 32.5% 84.9%;");
    expect(css).toContain("--button-foreground: 205 25% 18%;");
    expect(css).toContain('--app-font-heading: "sofia-pro", "Sofia Sans", sans-serif;');
  });

  it("googleFontsUrl skips Adobe fonts but includes the Sofia Sans fallback", () => {
    const url = googleFontsUrl({ body: "Karla", heading: "Sofia Pro" });
    expect(url).toContain("family=Karla");
    expect(url).toContain("family=Sofia+Sans");
    expect(url).not.toContain("Sofia+Pro");
    expect(googleFontsUrl({ body: "Inter", heading: "Lora" })).not.toContain("Sofia");
  });
});

// DEFAULT_THEME is a copy of index.css's tokens; keep them in lockstep.
describe("DEFAULT_THEME matches index.css", () => {
  const css = readFileSync(fileURLToPath(new URL("../../../../photo-album/src/index.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const block = (sel: string) => {
    const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(".", "\\.")}\\s*\\{([^}]*)\\}`));
    if (!m) throw new Error(`no ${sel} block in index.css`);
    return Object.fromEntries([...m[1].matchAll(/--([\w-]+):\s*([^;]+);/g)].map((x) => [x[1], x[2].trim()]));
  };
  // Added to index.css by the token-gaps work; asserted only once present.
  const optional = new Set(["warning", "warning-foreground", "success", "success-foreground"]);

  for (const [mode, sel] of [["light", ":root"], ["dark", ".dark"]] as const) {
    it(`${mode} colors`, () => {
      const vars = block(sel);
      for (const { key } of COLOR_TOKENS) {
        if (optional.has(key) && !(key in vars)) continue;
        expect(vars[key], `--${key} (${mode})`).toBe(DEFAULT_THEME[mode][key]);
      }
    });
  }

  it("fonts and weights", () => {
    const vars = block(":root");
    expect(vars["heading-weight"]).toBe(String(DEFAULT_THEME.headingWeight));
    expect(vars["button-weight"]).toBe(String(DEFAULT_THEME.buttonWeight));
    expect(vars["app-font-sans"]).toBe(`"${DEFAULT_THEME.fonts.body}", sans-serif`);
    expect(vars["app-font-heading"]).toBe('"sofia-pro", "Sofia Sans", sans-serif');
  });

  it("radius", () => {
    expect(block(":root").radius).toBe(`${DEFAULT_THEME.radius}rem`);
  });
});
