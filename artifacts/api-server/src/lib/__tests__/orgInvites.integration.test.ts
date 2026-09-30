import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import net from "node:net";

// Organization invites end to end, with nothing mocked: the invite route sends
// real SMTP (nodemailer) to an in-process mail catcher, and the invitee goes
// through real Better Auth sign-up, email verification and sign-in.
const PORT = 18765;
const SMTP_PORT = 18766;
vi.hoisted(() => {
  Object.assign(process.env, {
    BETTER_AUTH_SECRET: "invite-test-secret-0123456789abcdef0123456789",
    BETTER_AUTH_URL: "http://localhost:18765",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "18766",
    SMTP_USER: "catcher",
    SMTP_PASS: "catcher",
    EMAIL_FROM: "Vispix <noreply@vispix.dev>",
    APP_PUBLIC_URL: "https://app.test",
  });
});

// A minimal SMTP server: enough of the dialogue for nodemailer (EHLO, AUTH
// PLAIN/LOGIN, MAIL, RCPT, DATA), storing each message it receives.
interface Mail { to: string[]; raw: string }
const inbox: Mail[] = [];
let smtp: net.Server;
function startCatcher(): Promise<void> {
  smtp = net.createServer((sock) => {
    let buf = "";
    let inData = false;
    let data = "";
    let rcpt: string[] = [];
    let authStep = 0;
    sock.write("220 catcher ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            inbox.push({ to: rcpt, raw: data });
            data = "";
            rcpt = [];
            sock.write("250 queued\r\n");
          } else data += (line.startsWith("..") ? line.slice(1) : line) + "\r\n";
          continue;
        }
        if (authStep === 1) { authStep = 2; sock.write("334 UGFzc3dvcmQ6\r\n"); continue; }
        if (authStep === 2) { authStep = 0; sock.write("235 ok\r\n"); continue; }
        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO") || cmd.startsWith("HELO")) sock.write("250-catcher\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
        else if (cmd.startsWith("AUTH PLAIN")) sock.write("235 ok\r\n");
        else if (cmd.startsWith("AUTH LOGIN")) { authStep = 1; sock.write("334 VXNlcm5hbWU6\r\n"); }
        else if (cmd.startsWith("MAIL FROM")) sock.write("250 ok\r\n");
        else if (cmd.startsWith("RCPT TO") && cmd.includes("BOUNCE@")) sock.write("550 no such mailbox\r\n");
        else if (cmd.startsWith("RCPT TO")) { rcpt.push(line.replace(/^RCPT TO:\s*<?([^>]*)>?.*$/i, "$1").toLowerCase()); sock.write("250 ok\r\n"); }
        else if (cmd === "DATA") { inData = true; sock.write("354 go\r\n"); }
        else if (cmd === "QUIT") { sock.end("221 bye\r\n"); }
        else sock.write("250 ok\r\n");
      }
    });
  });
  return new Promise((r) => smtp.listen(SMTP_PORT, "127.0.0.1", () => r()));
}

/** The decoded text of a message (quoted-printable soft breaks and =XX escapes). */
function textOf(m: Mail): string {
  return m.raw.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
const subjectOf = (m: Mail) => /^Subject: (.*)$/m.exec(m.raw)?.[1] ?? "";
async function waitForMail(to: string, subject: RegExp, timeout = 5000): Promise<Mail> {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    const m = inbox.find((x) => x.to.includes(to) && subject.test(subjectOf(x)));
    if (m) return m;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no mail to ${to} matching ${subject}; inbox: ${inbox.map((x) => `${x.to} ${subjectOf(x)}`).join(" | ")}`);
}

import type { Server } from "node:http";
import app from "../../app";
import { db, pool, user, account, usersTable, organizationInvitesTable, organizationMembersTable, appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { resetDb, createOrganization, addOrganizationMember } from "./testDb";
import { acceptPendingInvites } from "../orgInvites";

let server: Server;
const base = `http://localhost:${PORT}/api`;
const ORIGIN = "http://localhost:8081";
let orgId: number;
let ownerCookie: string;

async function authed(cookie: string, path: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { ...init, headers: { cookie, origin: ORIGIN, "content-type": "application/json", ...(init.headers ?? {}) } });
}
async function signIn(email: string, password: string): Promise<{ status: number; cookie: string }> {
  const res = await fetch(`${base}/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ email, password }) });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, cookie };
}
async function seedAccount(id: string, email: string, password: string) {
  const now = new Date();
  await db.insert(user).values({ id, name: id, email, emailVerified: true, createdAt: now, updatedAt: now });
  await db.insert(account).values({ id: `${id}-acct`, accountId: id, providerId: "credential", userId: id, password: await hashPassword(password), createdAt: now, updatedAt: now });
  const [row] = await db.insert(usersTable).values({ authUserId: id, name: id, email, role: "member" }).returning();
  return row;
}
async function setRegistration(enabled: boolean) {
  await db.insert(appSettingsTable).values({ id: 1, registrationEnabled: enabled }).onConflictDoUpdate({ target: appSettingsTable.id, set: { registrationEnabled: enabled } });
}

beforeAll(async () => {
  await startCatcher();
  await resetDb();
  const owner = await seedAccount("owner-1", "owner@example.com", "owner-password-1");
  orgId = (await createOrganization({ name: "Invite Org" })).id;
  await addOrganizationMember(orgId, owner.id, "owner");
  await setRegistration(false);
  await new Promise<void>((resolve) => {
    server = app.listen(PORT, () => resolve());
  });
  const s = await signIn("owner@example.com", "owner-password-1");
  expect(s.status).toBe(200);
  ownerCookie = s.cookie;
}, 30_000);

afterAll(async () => {
  await setRegistration(true);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => smtp.close(() => resolve()));
  await pool.end();
});

describe("inviting someone new", () => {
  const invited = "new.person@example.com";

  it("emails the invitee a sign-up link for this organization", async () => {
    const res = await authed(ownerCookie, "/organizations/invites", { method: "POST", headers: { "x-organization-id": String(orgId) }, body: JSON.stringify({ email: "New.Person@Example.com", role: "member" }) });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { emailSent: boolean }).emailSent).toBe(true);
    const mail = await waitForMail(invited, /invited to Invite Org/);
    expect(textOf(mail)).toContain("Sign up with this email address");
    expect(subjectOf(mail)).toBe("You've been invited to Invite Org on Vispix");
    expect(textOf(mail)).toContain("https://app.test/sign-up?email=new.person%40example.com");
    expect(mail.raw).toMatch(/^From: Vispix <noreply@vispix\.dev>$/m);
  });

  it("lets only the invited address sign up while registration is closed", async () => {
    const stranger = await fetch(`${base}/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ email: "stranger@example.com", password: "stranger-password-1", name: "Stranger" }) });
    expect(stranger.status).toBe(403);
    const res = await fetch(`${base}/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ email: invited, password: "new-password-123", name: "New Person", callbackURL: "/sign-in?verified=1" }) });
    expect(res.status).toBe(200);
  });

  it("requires email verification, then joins the organization on first sign-in", async () => {
    expect((await signIn(invited, "new-password-123")).status).toBe(403);
    const verify = await waitForMail(invited, /verify|confirm/i);
    const link = /(http:\/\/localhost:18765\/api\/auth\/verify-email\?token=[^\s"<]+)/.exec(textOf(verify))?.[1];
    expect(link).toBeTruthy();
    const v = await fetch(link!.replace(/&amp;/g, "&"), { redirect: "manual" });
    expect([200, 302]).toContain(v.status);

    const s = await signIn(invited, "new-password-123");
    expect(s.status).toBe(200);
    const orgs = (await (await authed(s.cookie, "/organizations")).json()) as { id: number; name: string; role: string }[];
    expect(orgs.map((o) => [o.name, o.role])).toEqual([["Invite Org", "member"]]);
    const pending = await db.select().from(organizationInvitesTable).where(eq(organizationInvitesTable.email, invited));
    expect(pending).toEqual([]);
  });
});

describe("inviting someone who already has a Vispix account", () => {
  it("links them to sign-in and adds them when they next sign in", async () => {
    const existing = await seedAccount("existing-1", "existing@example.com", "existing-password-1");
    const other = await createOrganization({ name: "Their Own Org" });
    await addOrganizationMember(other.id, existing.id, "owner");

    const res = await authed(ownerCookie, "/organizations/invites", { method: "POST", headers: { "x-organization-id": String(orgId) }, body: JSON.stringify({ email: "Existing@Example.com" }) });
    expect(res.status).toBe(201);
    const mail = await waitForMail("existing@example.com", /invited to Invite Org/);
    expect(textOf(mail)).toContain("https://app.test/sign-in?email=existing%40example.com");
    expect(textOf(mail)).toContain("Sign in with this email address");

    const s = await signIn("existing@example.com", "existing-password-1");
    expect(s.status).toBe(200);
    const orgs = (await (await authed(s.cookie, "/organizations")).json()) as { name: string; role: string }[];
    expect(orgs.map((o) => [o.name, o.role]).sort()).toEqual([["Invite Org", "member"], ["Their Own Org", "owner"]]);
    expect(await db.select().from(organizationInvitesTable).where(eq(organizationInvitesTable.email, "existing@example.com"))).toEqual([]);
  });

  it("adds someone who's already signed in the next time the app loads their organizations", async () => {
    const already = await seedAccount("signed-in-1", "signed.in@example.com", "signed-in-password-1");
    const theirs = await createOrganization({ name: "Signed In Org" });
    await addOrganizationMember(theirs.id, already.id, "owner");
    const session = await signIn("signed.in@example.com", "signed-in-password-1");
    expect(((await (await authed(session.cookie, "/organizations")).json()) as unknown[]).length).toBe(1);

    await authed(ownerCookie, "/organizations/invites", { method: "POST", headers: { "x-organization-id": String(orgId) }, body: JSON.stringify({ email: "signed.in@example.com", role: "admin" }) });
    // Same session, no new sign-in.
    const orgs = (await (await authed(session.cookie, "/organizations")).json()) as { name: string; role: string }[];
    expect(orgs.map((o) => [o.name, o.role]).sort()).toEqual([["Invite Org", "admin"], ["Signed In Org", "owner"]]);
  });
});

describe("when the invite email can't be sent", () => {
  it("keeps the invite and tells the inviter", async () => {
    const res = await authed(ownerCookie, "/organizations/invites", { method: "POST", headers: { "x-organization-id": String(orgId) }, body: JSON.stringify({ email: "bounce@example.com" }) });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { emailSent: boolean }).emailSent).toBe(false);
    expect(await db.select().from(organizationInvitesTable).where(eq(organizationInvitesTable.email, "bounce@example.com"))).toHaveLength(1);
  });
});

describe("only a verified address accepts invites", () => {
  it("ignores an unverified address", async () => {
    const [u] = await db.insert(usersTable).values({ authUserId: "unverified-1", name: "U", email: "bounce@example.com", role: "member" }).returning();
    expect(await acceptPendingInvites(db, { userId: u.id, email: "bounce@example.com", emailVerified: false })).toEqual([]);
    expect(await db.select().from(organizationInvitesTable).where(eq(organizationInvitesTable.email, "bounce@example.com"))).toHaveLength(1);
    expect(await acceptPendingInvites(db, { userId: u.id, email: "Bounce@Example.com", emailVerified: true })).toEqual([orgId]);
  });
});
