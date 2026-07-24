import { useState } from "react";
import { Mail } from "lucide-react";
import { cn } from "@/lib/utils";

type Status = "idle" | "sending" | "sent" | "error";

// Superadmin diagnostic tile: emails the signed-in platform admin a test
// message to confirm SMTP delivery. Styled to sit in the superadmin card grid
// alongside the navigation cards; the whole tile is the action, and the result
// shows in the description line.
export function SendTestEmailCard() {
  const [status, setStatus] = useState<Status>("idle");
  const [detail, setDetail] = useState<string>("");

  async function send() {
    if (status === "sending") return;
    setStatus("sending");
    setDetail("");
    try {
      const res = await fetch("/api/admin/test-email", { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; to?: string; configured?: boolean }
        | null;
      if (!res.ok || !body) {
        setStatus("error");
        setDetail("Request failed. Are you signed in as a platform admin?");
      } else if (!body.configured) {
        setStatus("error");
        setDetail("SMTP isn't configured on this server.");
      } else if (body.ok) {
        setStatus("sent");
        setDetail(`Sent to ${body.to}. Check your inbox (and spam).`);
      } else {
        setStatus("error");
        setDetail("SMTP configured but the send failed — check server logs.");
      }
    } catch {
      setStatus("error");
      setDetail("Couldn't reach the server.");
    }
  }

  return (
    <button
      type="button"
      onClick={send}
      disabled={status === "sending"}
      className="group flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-amber-500/40 hover:bg-accent/50 disabled:opacity-70"
      data-testid="send-test-email-card"
    >
      <div className="h-9 w-9 shrink-0 rounded-lg bg-amber-500/10 flex items-center justify-center">
        <Mail className="h-[18px] w-[18px] text-amber-500" />
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-semibold text-foreground">
          {status === "sending" ? "Sending test email…" : "Send test email"}
        </h3>
        <p
          className={cn(
            "text-xs mt-0.5",
            status === "sent"
              ? "text-emerald-600 dark:text-emerald-400"
              : status === "error"
                ? "text-destructive"
                : "text-muted-foreground",
          )}
          data-testid="send-test-email-result"
        >
          {detail || "Email yourself a test to verify SMTP delivery."}
        </p>
      </div>
    </button>
  );
}
