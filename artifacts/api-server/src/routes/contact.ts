import { Router, type IRouter } from "express";
import { z } from "zod";
import { sendEmail, adminAlertEmail } from "../lib/email";
import { logger } from "../lib/logger";
import { clientIp } from "../lib/clientIp";

const router: IRouter = Router();

// Public, unauthenticated contact / enterprise-inquiry funnel. Emails the
// operator with the sender's message; reply-to is the sender so a reply from
// Gmail goes straight back to them.

const ContactBody = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  message: z.string().trim().min(1).max(5000),
  // Honeypot: bots fill hidden fields; humans leave it empty. Must be absent/empty.
  company: z.string().max(0).optional(),
});

// Naive per-IP rate limit (single instance, in-memory): at most MAX submissions
// per WINDOW. Good enough to blunt abuse of a public email-sending endpoint.
const WINDOW_MS = 60 * 60 * 1000;
const MAX = 5;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  // Opportunistic sweep so the Map can't grow unbounded (keys are per-client
  // addresses, see lib/clientIp): drop buckets whose every hit has aged out.
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= WINDOW_MS)) hits.delete(key);
    }
  }
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX;
}

router.post("/contact", async (req, res): Promise<void> => {
  const parsed = ContactBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please fill in your name, a valid email, and a message." });
    return;
  }
  // Silently accept honeypot hits so bots get no signal.
  if (parsed.data.company) {
    res.status(200).json({ ok: true });
    return;
  }

  const ip = clientIp(req);
  if (rateLimited(ip)) {
    res.status(429).json({ error: "Too many messages. Please try again later." });
    return;
  }

  const to = adminAlertEmail();
  if (!to) {
    // No operator inbox configured — accept so the UX still works, but log it.
    logger.warn("Contact form submitted but ADMIN_ALERT_EMAIL is unset; message dropped");
    res.status(200).json({ ok: true });
    return;
  }

  const { name, email, message } = parsed.data;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sent = await sendEmail({
    to,
    replyTo: email,
    subject: `Vispix contact from ${name}`,
    text: `From: ${name} <${email}>\n\n${message}`,
    html: `<p><strong>From:</strong> ${esc(name)} &lt;${esc(email)}&gt;</p><p style="white-space:pre-wrap;">${esc(message)}</p>`,
  });
  if (!sent) {
    res.status(502).json({ error: "Couldn't send your message right now. Please email us directly." });
    return;
  }
  res.status(200).json({ ok: true });
});

export default router;
