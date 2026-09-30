import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "../logger";

// Transactional email via SMTP (Elastic Email in production). Everything here
// is optional in dev: when SMTP isn't configured, sendEmail() logs a warning
// and no-ops, so the app boots and auth/invite flows still work without a
// provider. Wire real creds by setting SMTP_HOST/SMTP_USER/SMTP_PASS.

let cached: Transporter | null | undefined;

function getTransport(): Transporter | null {
  if (cached !== undefined) return cached;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    cached = null;
    return null;
  }
  const port = Number(process.env.SMTP_PORT ?? 587);
  cached = nodemailer.createTransport({
    host,
    port,
    // Port 465 is implicit TLS; 587/2525 upgrade via STARTTLS. Override with
    // SMTP_SECURE=true if a provider wants implicit TLS on a nonstandard port.
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    auth: { user, pass },
    // Bounded so a slow provider can't hold a request (invites await the send).
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return cached;
}

export function isEmailConfigured(): boolean {
  return getTransport() !== null;
}

const DEFAULT_FROM = "Vispix <noreply@vispix.dev>";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Where replies go. Defaults to EMAIL_REPLY_TO if set, else the From address. */
  replyTo?: string;
}

// Sends one email. Returns true on success, false if not configured or the
// send failed — callers treat email as best-effort and never block on it.
export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  const transport = getTransport();
  if (!transport) {
    // Dev fallback: with no SMTP configured, log the full text body (including
    // any reset/verify links) so local flows are testable without a provider.
    // NEVER log the body in production — gate on NODE_ENV as well as config, so
    // a prod deploy that's somehow missing SMTP can't spill tokens into logs.
    const isProd = process.env.NODE_ENV === "production";
    logger.warn(
      isProd
        ? { to: input.to, subject: input.subject }
        : { to: input.to, subject: input.subject, body: input.text },
      isProd
        ? "Email not sent: SMTP not configured (set SMTP_HOST/SMTP_USER/SMTP_PASS)"
        : "Email not sent: SMTP not configured (set SMTP_HOST/SMTP_USER/SMTP_PASS) — logging body for local dev",
    );
    return false;
  }
  try {
    await transport.sendMail({
      from: process.env.EMAIL_FROM ?? DEFAULT_FROM,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      replyTo: input.replyTo ?? process.env.EMAIL_REPLY_TO,
    });
    logger.info({ to: input.to, subject: input.subject }, "Email sent");
    return true;
  } catch (err) {
    logger.error({ err, to: input.to, subject: input.subject }, "Email send failed");
    return false;
  }
}

// Absolute URL into the web app, for links inside emails. APP_PUBLIC_URL is the
// public web origin (https://vispix.dev in prod); falls back to the Vite dev
// server so reset links are clickable in local development too.
export function appUrl(path: string): string {
  const base = (process.env.APP_PUBLIC_URL ?? "http://localhost:8081").replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

// The address that receives operational alerts (new signups, new orgs, contact
// form). Null when unset — callers skip the alert rather than erroring.
export function adminAlertEmail(): string | null {
  const addr = process.env.ADMIN_ALERT_EMAIL?.trim();
  return addr ? addr : null;
}
