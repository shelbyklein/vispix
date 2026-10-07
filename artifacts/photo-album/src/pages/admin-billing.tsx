import { useEffect, useRef } from "react";
import {
  useBillingStatus,
  useCreateCheckoutSession,
  useCreatePortalSession,
  useInvalidateBillingStatus,
} from "@workspace/api-client-react";
import { AdminSectionShell } from "@/components/admin/AdminSectionShell";
import { Button } from "@/components/ui/button";
import { CreditCard, Loader2, Sparkles, Mail, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { PLAN_CARDS, ENTERPRISE_CONTACT } from "@/lib/planDisplay";

// Bytes → a compact human size for the usage readout (GB with one decimal once
// we're past 1 GB, MB below that).
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export default function AdminBillingPage() {
  const { toast } = useToast();
  const { data: status, isLoading } = useBillingStatus();
  const { mutate: startCheckout, isPending: checkoutPending } = useCreateCheckoutSession();
  const { mutate: openPortal, isPending: portalPending } = useCreatePortalSession();
  const invalidateBilling = useInvalidateBillingStatus();

  // Toast + refresh on return from Stripe Checkout (?checkout=success|cancel),
  // then strip the param so a refresh doesn't re-toast.
  const handledReturn = useRef(false);
  useEffect(() => {
    if (handledReturn.current) return;
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get("checkout");
    if (!checkout) return;
    handledReturn.current = true;
    if (checkout === "success") {
      toast({ title: "Subscription active", description: "Your plan will update momentarily." });
      invalidateBilling();
    } else if (checkout === "cancel") {
      toast({ title: "Checkout canceled" });
    }
    params.delete("checkout");
    const qs = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
  }, [toast, invalidateBilling]);

  function handleUpgrade() {
    startCheckout(undefined, {
      onSuccess: ({ url }) => window.location.assign(url),
      onError: () =>
        toast({ title: "Couldn't start checkout", description: "Billing may not be configured yet.", variant: "destructive" }),
    });
  }

  function handleManage() {
    openPortal(undefined, {
      onSuccess: ({ url }) => window.location.assign(url),
      onError: () => toast({ title: "Couldn't open the billing portal", variant: "destructive" }),
    });
  }

  const unlimited = status?.capBytes == null;
  const pct = status && !unlimited && status.capBytes ? Math.min(100, Math.round(status.ratio * 100)) : 0;
  const barColor = status?.overLimit ? "bg-red-500" : status?.nearLimit ? "bg-warning" : "bg-primary";

  return (
    <AdminSectionShell
      title="Billing"
      icon={CreditCard}
      description="Your organization's plan, storage usage, and subscription."
    >
      {isLoading || !status ? (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="max-w-2xl space-y-6">
          {/* Current plan + usage */}
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-semibold text-foreground">{status.planLabel}</span>
                  {status.status !== "inactive" && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground capitalize">
                      {status.status.replace(/_/g, " ")}
                    </span>
                  )}
                </div>
                {status.cancelAtPeriodEnd && status.currentPeriodEnd && (
                  <p className="text-xs text-warning mt-1">
                    Cancels on {new Date(status.currentPeriodEnd).toLocaleDateString()}
                  </p>
                )}
              </div>
            </div>

            {/* Usage bar */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Storage used</span>
                <span className="font-medium text-foreground">
                  {formatBytes(status.usageBytes)}
                  {unlimited ? " — Unlimited" : ` / ${formatBytes(status.capBytes ?? 0)}`}
                </span>
              </div>
              {!unlimited && (
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted" data-testid="usage-bar">
                  <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
                </div>
              )}
              {status.overLimit && (
                <p className="text-xs font-medium text-red-600 dark:text-red-500">
                  Storage limit reached — new uploads are blocked until you upgrade or free up space.
                </p>
              )}
              {!status.overLimit && status.nearLimit && (
                <p className="text-xs font-medium text-warning">
                  You're approaching your storage limit.
                </p>
              )}
            </div>
          </div>

          {/* Actions */}
          {status.canManage ? (
            <div className="flex flex-wrap items-center gap-3">
              {status.plan !== "pro" && status.plan !== "enterprise" && (
                <Button onClick={handleUpgrade} disabled={checkoutPending} className="gap-1.5" data-testid="upgrade-pro-btn">
                  {checkoutPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  Upgrade to Pro
                </Button>
              )}
              {status.hasStripeCustomer && (
                <Button variant="outline" onClick={handleManage} disabled={portalPending} className="gap-1.5" data-testid="manage-sub-btn">
                  {portalPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
                  Manage subscription
                </Button>
              )}
              {status.plan !== "enterprise" && (
                <a href={ENTERPRISE_CONTACT}>
                  <Button variant="ghost" className="gap-1.5" data-testid="enterprise-contact-btn">
                    <Mail className="h-4 w-4" />
                    Need more? Contact us about Enterprise
                  </Button>
                </a>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Only an organization owner or admin can change the plan.
            </p>
          )}

          {/* Plan comparison */}
          <div className="grid gap-3 sm:grid-cols-3">
            {(["free", "pro", "enterprise"] as const).map((id) => {
              const plan = PLAN_CARDS[id];
              const current = status.plan === id;
              return (
                <div
                  key={id}
                  className={`rounded-xl border p-4 ${current ? "border-primary bg-primary/5" : "border-border bg-card"}`}
                  data-testid={`plan-card-${id}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-foreground">{plan.label}</span>
                    {current && <span className="text-xs font-medium text-primary">Current</span>}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{plan.priceDisplay}</p>
                  <p className="mt-2 text-xs text-muted-foreground">{plan.blurb}</p>
                  {id === "enterprise" && (
                    <a href={ENTERPRISE_CONTACT} className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                      Contact us <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </AdminSectionShell>
  );
}
