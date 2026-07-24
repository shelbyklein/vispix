import { Link } from "wouter";
import {
  Upload,
  Sparkles,
  Star,
  FolderOpen,
  Search,
  CopyCheck,
  Users,
  Tag,
  Bot,
  ArrowRight,
  ShieldCheck,
  Check,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useGetRegistrationSettings } from "@workspace/api-client-react";
import { PLAN_CARDS, PLAN_ORDER, ENTERPRISE_CONTACT } from "@/lib/planDisplay";

// The pitch, in the order a visitor needs it: the transformation (hero + a
// product mock so they SEE it), how it works, the superpowers (each led by the
// pain it kills), why not a shared drive, and what it costs. Pricing is pulled
// from the shared plan display so marketing can't drift from billing. Copy
// stays honest to the shipped feature set.

const STEPS = [
  { icon: Upload, title: "Upload", text: "Drag in photos — thousands at a time." },
  { icon: Sparkles, title: "AI triages", text: "Every photo described; duplicates and near-duplicates flagged automatically." },
  { icon: Star, title: "Rate together", text: "Your whole team scores candidates, so the best shots rise." },
  { icon: FolderOpen, title: "Ship collections", text: "Shortlist into collections and hand off to design." },
];

// Each superpower leads with the win and the pain it removes — not the mechanism.
const SUPERPOWERS = [
  {
    icon: Search,
    title: "Search by describing it",
    text: "“Celebrating in the rain” finds the shot. AI writes a description for every photo, so you search in plain language.",
    pain: "No more scrubbing thousands of thumbnails.",
  },
  {
    icon: Sparkles,
    title: "AI triages every upload",
    text: "Descriptions written, byte-identical copies and look-alikes flagged, before you lift a finger.",
    pain: "The busywork is done before you start.",
  },
  {
    icon: Star,
    title: "Decide as a team",
    text: "Everyone scores candidates in place and the best rise to the top — one decision, made together.",
    pain: "No more endless “which one?” email threads.",
  },
  {
    icon: ShieldCheck,
    title: "Rights you can trust",
    text: "Attribution tags track exactly what each photo is cleared for — web, print, social.",
    pain: "Never ship a photo you’re not licensed to use.",
  },
  {
    icon: Users,
    title: "Find anyone instantly",
    text: "Tag the people in your photos and pull up every shot of someone in one click.",
    pain: "Stop hunting for “that one photo of them”.",
  },
  {
    icon: CopyCheck,
    title: "Clean, organized library",
    text: "Group shortlists into collections and projects; near-duplicates get side-by-side review to clear fast.",
    pain: "Your dumping ground becomes an asset library.",
  },
];

// A mock of the product for the hero — pure CSS/JSX, theme-aware, no screenshot
// needed. It reads left-to-right as: search a pile of photos → get ranked,
// rated, rights-tagged results.
function AppMock() {
  const tiles = [
    "from-violet-400 to-fuchsia-500",
    "from-sky-400 to-indigo-500",
    "from-amber-300 to-orange-500",
    "from-emerald-400 to-teal-500",
    "from-rose-400 to-pink-500",
    "from-cyan-400 to-blue-500",
    "from-lime-400 to-green-500",
    "from-fuchsia-400 to-purple-500",
  ];
  return (
    <div className="mx-auto mt-14 w-full max-w-3xl rounded-2xl border border-border bg-card shadow-xl overflow-hidden" aria-hidden>
      {/* window chrome */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
        <div className="ml-3 flex flex-1 items-center gap-2 rounded-md bg-muted/60 px-3 py-1.5 text-sm text-muted-foreground">
          <Search className="h-3.5 w-3.5" />
          <span className="text-foreground">celebrating in the rain</span>
          <span className="ml-auto text-xs">8 results</span>
        </div>
      </div>
      {/* results grid */}
      <div className="grid grid-cols-4 gap-3 p-4">
        {tiles.map((t, i) => (
          <div key={i} className={`relative aspect-square rounded-lg bg-gradient-to-br ${t}`}>
            {i === 0 && (
              <span className="absolute left-1.5 top-1.5 flex items-center gap-0.5 rounded bg-black/40 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">
                <Star className="h-2.5 w-2.5 fill-current" /> 4.8
              </span>
            )}
            {i === 2 && (
              <span className="absolute bottom-1.5 left-1.5 rounded bg-black/40 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">
                Cleared · Social
              </span>
            )}
            {i === 5 && (
              <span className="absolute left-1.5 top-1.5 rounded bg-black/40 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">
                Near-dup
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const COMPARISON: { label: string; drive: string; vispix: string }[] = [
  { label: "Find a photo", drive: "Scroll endlessly through folders", vispix: "Describe it in plain language" },
  { label: "Duplicates", drive: "Pile up unnoticed", vispix: "Flagged automatically" },
  { label: "Picking the best", drive: "Endless email threads", vispix: "Team ratings, decided in place" },
  { label: "Usage rights", drive: "Hope someone remembers", vispix: "Tracked per photo" },
  { label: "Your AI tools", drive: "—", vispix: "Ask Claude directly (MCP)" },
];

export default function Home() {
  const { data: regSettings } = useGetRegistrationSettings();
  const registrationEnabled = regSettings?.registrationEnabled ?? true;

  return (
    <div className="min-h-screen bg-background" data-testid="home-page">
      <header className="border-b border-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <img src="/vispix.png" alt="Vispix" className="h-8 w-8 rounded" />
          <span className="text-xl font-semibold tracking-tight text-foreground">Vispix</span>
        </div>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <Link href="/sign-in">
            <Button variant="outline" data-testid="sign-in-btn">Sign In</Button>
          </Link>
          {registrationEnabled && (
            <Link href="/sign-up">
              <Button data-testid="sign-up-btn">Sign Up</Button>
            </Link>
          )}
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="max-w-5xl mx-auto px-6 pt-16 pb-8 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
            <Zap className="h-3.5 w-3.5 text-primary" />
            Marketing asset library with superpowers
          </span>
          <h1 className="mt-6 text-4xl sm:text-5xl font-bold tracking-tight text-foreground leading-tight">
            Give your marketing photos<br />superpowers.
          </h1>
          <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mt-6 leading-relaxed">
            Drop in thousands of raw event photos and get back an intelligent, searchable,
            rights-aware library: AI describes and de-duplicates every shot, plain-language search
            finds it, your team rates the best, and even your AI tools can pull photos on demand.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-9">
            {registrationEnabled ? (
              <Link href="/sign-up">
                <Button size="lg" data-testid="home-sign-up-btn" className="px-8 gap-1.5">
                  Start free <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="registration-disabled-msg">
                Registration is by invitation only. Contact your administrator to get access.
              </p>
            )}
            <Link href="/sign-in">
              <Button size="lg" variant="outline" data-testid="home-sign-in-btn" className="px-8">
                Sign In
              </Button>
            </Link>
          </div>
          {registrationEnabled && (
            <p className="mt-3 text-xs text-muted-foreground">2 GB free · no card required</p>
          )}

          <AppMock />
        </section>

        {/* How it works */}
        <section className="border-y border-border bg-card/50">
          <div className="max-w-5xl mx-auto px-6 py-14">
            <h2 className="text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-8">
              From dump to done, in four steps
            </h2>
            <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((step, i) => (
                <div key={step.title} className="text-center space-y-2">
                  <div className="mx-auto h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <step.icon className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="font-semibold text-foreground">
                    <span className="text-primary mr-1.5">{i + 1}.</span>
                    {step.title}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{step.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Superpowers */}
        <section className="max-w-5xl mx-auto px-6 py-16">
          <div className="text-center mb-10">
            <h2 className="text-2xl font-bold text-foreground">Six superpowers for your photo library</h2>
            <p className="text-sm text-muted-foreground mt-2">Every one removes a chore you do today.</p>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 text-left">
            {SUPERPOWERS.map((f) => (
              <div key={f.title} className="rounded-xl border border-border bg-card p-5 space-y-3">
                <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                  <f.icon className="h-5 w-5 text-primary" />
                </div>
                <h3 className="font-semibold text-foreground">{f.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{f.text}</p>
                <p className="flex items-start gap-1.5 text-sm font-medium text-foreground">
                  <Check className="h-4 w-4 mt-0.5 shrink-0 text-emerald-500" />
                  {f.pain}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* MCP — the differentiator, given room */}
        <section className="border-y border-border bg-card/50">
          <div className="max-w-4xl mx-auto px-6 py-14 grid gap-8 md:grid-cols-[auto,1fr] md:items-center">
            <div className="mx-auto h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center">
              <Bot className="h-8 w-8 text-primary" />
            </div>
            <div className="text-center md:text-left">
              <h2 className="text-2xl font-bold text-foreground">Your library, answerable by AI</h2>
              <p className="text-muted-foreground mt-2 leading-relaxed">
                Connect Claude or other AI tools straight to your photo library over MCP, then ask for
                photos in plain language from anywhere — “find three hero shots from the spring event
                cleared for social.” Your assets stop being a folder and start being an assistant.
              </p>
            </div>
          </div>
        </section>

        {/* Why not a shared drive */}
        <section className="max-w-3xl mx-auto px-6 py-16">
          <h2 className="text-center text-2xl font-bold text-foreground mb-8">Why not just a shared drive?</h2>
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="grid grid-cols-[1fr,1fr,1fr] bg-card text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <div className="px-4 py-3" />
              <div className="px-4 py-3 border-l border-border">Shared drive</div>
              <div className="px-4 py-3 border-l border-border text-primary">Vispix</div>
            </div>
            {COMPARISON.map((row, i) => (
              <div key={row.label} className={`grid grid-cols-[1fr,1fr,1fr] text-sm ${i % 2 ? "bg-card/50" : "bg-background"}`}>
                <div className="px-4 py-3 font-medium text-foreground">{row.label}</div>
                <div className="px-4 py-3 border-l border-border text-muted-foreground flex items-center gap-1.5">
                  {row.drive === "—" ? <X className="h-3.5 w-3.5 text-muted-foreground/60" /> : null}
                  {row.drive}
                </div>
                <div className="px-4 py-3 border-l border-border text-foreground flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                  {row.vispix}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Pricing */}
        <section className="border-t border-border bg-card/50">
          <div className="max-w-5xl mx-auto px-6 py-16">
            <h2 className="text-center text-2xl font-bold text-foreground mb-2">Simple pricing</h2>
            <p className="text-center text-sm text-muted-foreground mb-10">
              Priced by storage, not seats — invite your whole team on any plan.
            </p>
            <div className="grid gap-4 sm:grid-cols-3 max-w-3xl mx-auto">
              {PLAN_ORDER.map((id) => {
                const plan = PLAN_CARDS[id];
                const highlight = id === "pro";
                return (
                  <div
                    key={id}
                    className={`rounded-xl border p-5 flex flex-col ${highlight ? "border-primary bg-primary/5" : "border-border bg-card"}`}
                    data-testid={`home-plan-${id}`}
                  >
                    <h3 className="font-semibold text-foreground">{plan.label}</h3>
                    <p className="mt-1 text-2xl font-bold text-foreground">{plan.priceDisplay}</p>
                    <p className="mt-2 text-sm text-muted-foreground flex-1">{plan.blurb}</p>
                    <div className="mt-4">
                      {id === "enterprise" ? (
                        <a href={ENTERPRISE_CONTACT}>
                          <Button variant="outline" size="sm" className="w-full">Contact us</Button>
                        </a>
                      ) : registrationEnabled ? (
                        <Link href="/sign-up">
                          <Button size="sm" variant={highlight ? "default" : "outline"} className="w-full">
                            {id === "free" ? "Start free" : "Start with Pro"}
                          </Button>
                        </Link>
                      ) : (
                        <Button size="sm" variant="outline" className="w-full" disabled>
                          By invitation
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-center text-xs text-muted-foreground mt-6 inline-flex w-full justify-center items-center gap-1">
              <Tag className="h-3 w-3" /> Every plan includes AI descriptions, search, ratings, and collections.
            </p>
          </div>
        </section>

        {/* Final CTA */}
        {registrationEnabled && (
          <section className="max-w-3xl mx-auto px-6 py-20 text-center">
            <h2 className="text-3xl font-bold text-foreground">Give your photos superpowers</h2>
            <p className="text-muted-foreground mt-3">Start free with 2 GB — no card required.</p>
            <Link href="/sign-up">
              <Button size="lg" className="mt-6 px-8 gap-1.5">
                Start free <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </section>
        )}
      </main>

      <footer className="border-t border-border py-8 text-sm text-muted-foreground">
        <div className="max-w-5xl mx-auto px-6 flex items-center justify-between">
          <span>© {new Date().getFullYear()} Vispix</span>
          <a href={ENTERPRISE_CONTACT} className="hover:text-foreground">Contact us</a>
        </div>
      </footer>
    </div>
  );
}
