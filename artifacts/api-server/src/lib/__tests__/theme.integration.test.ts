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
import { COLOR_TOKENS, DEFAULT_THEME, googleFontsUrl, type PlatformTheme, type PlatformThemeState } from "@workspace/api-zod/theme";
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

  it("radius", () => {
    expect(block(":root").radius).toBe(`${DEFAULT_THEME.radius}rem`);
  });
});
