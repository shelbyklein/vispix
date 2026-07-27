import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  organizationsTable,
  organizationMembersTable,
  organizationAlertsTable,
  usersTable,
} from "@workspace/db";
import { sendEmail, isEmailConfigured, appUrl } from "./email";
import { aiQuotaIncidentEmail } from "./email/templates";
import { logger } from "./logger";

// Automated org-admin incident alerts: when the system detects an issue that
// needs an organization's attention (e.g. its AI provider account is out of
// quota), it emails that org's owners/admins directly — once per cooldown
// window, however often the condition re-triggers. Best-effort: failures are
// logged, never thrown into the detecting code path.

const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // at most one email per kind per day

export type OrgAlertKind = "ai_provider_quota";

/**
 * Claim the right to send this (org, kind) alert. Upserts the cooldown row and
 * only "wins" when no alert was sent within the window — the conditional
 * upsert makes concurrent detections race-safe (exactly one caller wins).
 */
async function claimAlertSlot(organizationId: number, kind: OrgAlertKind): Promise<boolean> {
  const cutoff = new Date(Date.now() - ALERT_COOLDOWN_MS);
  const rows = await db
    .insert(organizationAlertsTable)
    .values({ organizationId, kind, lastSentAt: new Date() })
    .onConflictDoUpdate({
      target: [organizationAlertsTable.organizationId, organizationAlertsTable.kind],
      set: { lastSentAt: new Date() },
      setWhere: sql`${organizationAlertsTable.lastSentAt} < ${cutoff}`,
    })
    .returning({ organizationId: organizationAlertsTable.organizationId });
  return rows.length > 0;
}

async function orgAdminRecipients(organizationId: number): Promise<{ orgName: string; emails: string[] } | null> {
  const [org] = await db
    .select({ name: organizationsTable.name })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId));
  if (!org) return null;
  const members = await db
    .select({ email: usersTable.email })
    .from(organizationMembersTable)
    .innerJoin(usersTable, eq(organizationMembersTable.userId, usersTable.id))
    .where(
      and(
        eq(organizationMembersTable.organizationId, organizationId),
        inArray(organizationMembersTable.role, ["owner", "admin"]),
      ),
    );
  const emails = [...new Set(members.map((m) => m.email).filter((e): e is string => !!e?.includes("@")))];
  return { orgName: org.name, emails };
}

/**
 * Notify an org's admins that AI processing is paused because the org's
 * provider account hit a quota / rate-limit error. Fire-and-forget safe.
 */
export async function notifyAiQuotaIncident(organizationId: number): Promise<void> {
  try {
    if (!isEmailConfigured()) return;
    if (!(await claimAlertSlot(organizationId, "ai_provider_quota"))) return;

    const recipients = await orgAdminRecipients(organizationId);
    if (!recipients || recipients.emails.length === 0) return;

    const content = aiQuotaIncidentEmail(recipients.orgName, appUrl("/admin/ai-services"));
    for (const to of recipients.emails) {
      await sendEmail({ to, ...content });
    }
    logger.info(
      { organizationId, recipients: recipients.emails.length },
      "Org incident alert sent: AI provider quota",
    );
  } catch (err) {
    logger.error({ err, organizationId }, "Org incident alert failed");
  }
}

/** Quota / rate-limit detection shared by the alerting call sites. */
export function isQuotaError(message: string | null | undefined): boolean {
  const msg = (message ?? "").toLowerCase();
  return msg.includes("quota") || msg.includes("429") || msg.includes("rate limit");
}
