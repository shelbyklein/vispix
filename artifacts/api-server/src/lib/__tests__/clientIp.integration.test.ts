import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Per-client rate limiting behind Cloudflare → cloudflared → nginx (#230).
import type { Server } from "node:http";
import app from "../../app";
import { pool } from "@workspace/db";
import { clientIp } from "../clientIp";

const req = (peer: string, cf?: string | string[], ip = "172.18.0.1") =>
  ({ headers: cf === undefined ? {} : { "cf-connecting-ip": cf }, ip, socket: { remoteAddress: peer } }) as unknown as Parameters<typeof clientIp>[0];

describe("clientIp", () => {
  it.each(["127.0.0.1", "::1", "::ffff:172.18.0.3", "10.0.0.5", "192.168.1.9", "fd12:3456::1"])("uses CF-Connecting-IP from our proxy (%s)", (peer) => {
    expect(clientIp(req(peer, "203.0.113.7"))).toBe("203.0.113.7");
    expect(clientIp(req(peer, "2001:db8::42"))).toBe("2001:db8::42");
  });
  it("ignores the header from a public peer (can't pick its own key)", () => {
    expect(clientIp(req("198.51.100.4", "203.0.113.7", "198.51.100.4"))).toBe("198.51.100.4");
  });
  it("ignores a missing or malformed header", () => {
    expect(clientIp(req("127.0.0.1"))).toBe("172.18.0.1");
    expect(clientIp(req("127.0.0.1", "not-an-ip, 1.2.3.4"))).toBe("172.18.0.1");
    expect(clientIp(req("127.0.0.1", ["203.0.113.9", "1.1.1.1"]))).toBe("203.0.113.9");
  });
});

let server: Server;
let base: string;
beforeAll(async () => {
  delete process.env.ADMIN_ALERT_EMAIL;
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

describe("contact form limit is per visitor, not shared", () => {
  const post = (cf: string) =>
    fetch(`${base}/contact`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": cf },
      body: JSON.stringify({ name: "N", email: "n@example.com", message: "hello" }),
    }).then((r) => r.status);
  it("one visitor hitting the limit doesn't block another", async () => {
    for (let i = 0; i < 5; i++) expect(await post("203.0.113.10")).toBe(200);
    expect(await post("203.0.113.10")).toBe(429);
    expect(await post("203.0.113.11")).toBe(200);
  });
});
