import { Link } from "wouter";
import { useOnboardingStatus, useDismissOnboarding, useGetMe } from "@workspace/api-client-react";
import { useOrg } from "@/contexts/OrgContext";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { CircleCheck, Circle, X, ChevronRight, Rocket } from "lucide-react";

type Step = {
  key: string;
  label: string;
  blurb: string;
  href: string;
  done: boolean;
  managerOnly?: boolean;
};

// Dismissible "Getting started" tour on the dashboard (#148) — one step per
// major thing the app can do, in the order a new org would use them. Steps are
// derived from real data server-side, so they complete themselves as the user
// acts. Done steps collapse to a strikethrough; open ones show a short blurb
// about what the feature is. Auto-hides when dismissed or fully complete.
export function GettingStartedCard() {
  const { data: status } = useOnboardingStatus();
  const { data: me } = useGetMe();
  const { activeOrg } = useOrg();
  const { mutate: dismiss, isPending: dismissing } = useDismissOnboarding();

  if (!status || status.dismissed) return null;

  const isManager =
    me?.role === "admin" || activeOrg?.role === "owner" || activeOrg?.role === "admin";

  const steps: Step[] = [
    {
      key: "org",
      label: "Create your organization",
      blurb: "Your team's private photo workspace.",
      href: "/admin/organization",
      done: true,
    },
    {
      key: "ai",
      label: "Add an AI provider",
      blurb: "Connect OpenAI, Anthropic, or Gemini so photos get auto-described and searchable.",
      href: "/admin/ai-services",
      done: status.aiConfigured,
      managerOnly: true,
    },
    {
      key: "photos",
      label: "Upload photos",
      blurb: "Bring in your event photos — uploads land in albums.",
      href: "/bulk-upload",
      done: status.hasPhotos,
    },
    {
      key: "collection",
      label: "Curate a collection",
      blurb: "Group photos by what they are — an event, a trip, a theme.",
      href: "/collections",
      done: status.hasCollectionPhotos,
    },
    {
      key: "analysis",
      label: "Verify AI processing",
      blurb: "Check AI Analysis until every photo has a description — that's what powers search.",
      href: "/admin/ai-analysis",
      done: status.aiAnalysisComplete,
      managerOnly: true,
    },
    {
      key: "smart",
      label: "Try a smart collection",
      blurb: "Give a collection a search phrase and it ranks photos by AI similarity — a self-updating gallery.",
      href: "/smart-collections",
      done: status.hasSmartCollection,
    },
    {
      key: "project",
      label: "Start a project",
      blurb: "Projects gather photos for one deliverable, like a brochure or social push.",
      href: "/projects",
      done: status.hasProject,
    },
    {
      key: "tags",
      label: "Label your collections",
      blurb: "Add tags to collections so you can filter them by theme.",
      href: "/collections",
      done: status.hasCollectionTag,
    },
    {
      key: "person",
      label: "Add a person",
      blurb: "People group photos by who's in them — every shot of one person under their name.",
      href: "/people",
      done: status.hasTaggedPerson,
    },
    {
      key: "attribution",
      label: "Mark attribution",
      blurb: "Usage-rights tags record what your team allows a photo to be used for — web, print, social.",
      href: "/photos",
      done: status.hasAttribution,
    },
    {
      key: "invite",
      label: "Invite a teammate",
      blurb: "Bring in the rest of the team to rate and pick photos together.",
      href: "/admin/members",
      done: status.invitedTeammate,
      managerOnly: true,
    },
    {
      key: "mcp",
      label: "Connect MCP",
      blurb: "Create an MCP token to search your library from Claude and other AI tools.",
      href: "/admin/mcp-tokens",
      done: status.hasMcpToken,
      managerOnly: true,
    },
  ].filter((s) => isManager || !s.managerOnly);

  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-4 sm:p-5" data-testid="getting-started-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="h-9 w-9 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center">
            <Rocket className="h-[18px] w-[18px] text-primary" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">Getting started</h2>
            <p className="text-xs text-muted-foreground">
              {doneCount} of {steps.length} done — a quick tour of everything Vispix can do
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => dismiss()}
          disabled={dismissing}
          title="Dismiss"
          aria-label="Dismiss getting started checklist"
          data-testid="dismiss-getting-started"
        >
          <X className="h-4 w-4 text-muted-foreground" />
        </Button>
      </div>

      <Progress value={(doneCount / steps.length) * 100} className="mt-3 h-1.5" />

      <ul className="mt-3 grid gap-1 sm:grid-cols-2">
        {steps.map((step) => (
          <li key={step.key}>
            {step.done ? (
              <span className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground">
                <CircleCheck className="h-4 w-4 shrink-0 text-success" />
                <span className="line-through decoration-muted-foreground/40">{step.label}</span>
              </span>
            ) : (
              <Link
                href={step.href}
                className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/60 transition-colors"
                data-testid={`getting-started-${step.key}`}
              >
                <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50" />
                <span className="min-w-0">
                  <span className="flex items-center gap-1 text-sm text-foreground">
                    {step.label}
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 -translate-x-1 transition-all group-hover:opacity-100 group-hover:translate-x-0" />
                  </span>
                  <span className="block text-xs text-muted-foreground">{step.blurb}</span>
                </span>
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
