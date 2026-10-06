import { useEffect, useState } from "react";
import { Link } from "wouter";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Bot, Check, CopyCheck, Search, ShieldCheck, Star, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useGetRegistrationSettings } from "@workspace/api-client-react";
import { PLAN_CARDS, PLAN_ORDER, ENTERPRISE_CONTACT } from "@/lib/planDisplay";

// Marketing home for signed-out visitors. The pitch, in the order a visitor
// needs it: the outcome (find the shot), the search itself, what the library
// does for a team, how photos flow through it, why a shared drive falls short,
// and what it costs. Pricing comes from the shared plan display so marketing
// can't drift from billing. Copy stays honest to the shipped feature set.
//
// Photography: placeholder images (picsum, seeded so they're stable). Replace
// with licensed photos from a customer library before this ships widely; the
// review screenshots show real athletes and stay private.
const photo = (seed: string, w: number, h: number) => `https://picsum.photos/seed/vispix-${seed}/${w}/${h}`;

const QUERIES = [
  "athletes celebrating on the podium",
  "close-up of hands nocking an arrow",
  "Fri-pm (146).webp",
  "team huddle before the final, cleared for social",
];

const ease = [0.16, 1, 0.3, 1] as const;

// Titles on tinted cards use role="heading" text, not <h3>: the global heading
// colour is !important in the base layer and would override their contrast.

function Reveal({ children, delay = 0, className }: { children: React.ReactNode; delay?: number; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration: 0.7, delay, ease }}
    >
      {children}
    </motion.div>
  );
}

// The search box cycles through real kinds of request (a description, a
// filename, a rights-aware ask) to show what "describe it" means. Static under
// reduced motion.
function CyclingQuery() {
  const reduce = useReducedMotion();
  const [i, setI] = useState(0);
  useEffect(() => {
    if (reduce) return;
    const t = setInterval(() => setI((n) => (n + 1) % QUERIES.length), 3200);
    return () => clearInterval(t);
  }, [reduce]);
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-card px-5 py-4 shadow-[0_20px_60px_-30px_hsl(var(--primary)/0.45)]">
      <Search className="h-5 w-5 shrink-0 text-primary" aria-hidden />
      <div className="relative h-7 flex-1 overflow-hidden text-lg text-foreground" aria-live="off">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={QUERIES[i]}
            className="absolute inset-0 truncate"
            initial={reduce ? false : { y: 18, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={reduce ? undefined : { y: -18, opacity: 0 }}
            transition={{ duration: 0.45, ease }}
          >
            {QUERIES[i]}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}

const DRIVE_VS: { drive: string; vispix: string }[] = [
  { drive: "Scroll folders until something looks right", vispix: "Describe the photo, or paste its filename" },
  { drive: "Duplicates pile up unnoticed", vispix: "Exact and near-duplicates flagged on upload" },
  { drive: "Pick favourites over email", vispix: "The team rates in place and the best rise" },
  { drive: "Hope someone remembers the usage rights", vispix: "Rights tracked on every photo" },
];

export default function Home() {
  const { data: regSettings } = useGetRegistrationSettings();
  const registrationEnabled = regSettings?.registrationEnabled ?? true;
  const reduce = useReducedMotion();

  const startFree = (testId: string, size: "lg" | "default" = "lg") =>
    registrationEnabled ? (
      <Link href="/sign-up">
        <Button size={size} data-testid={testId} className="gap-1.5 rounded-full px-7 active:scale-[0.98]">
          Start free <ArrowRight className="h-4 w-4" />
        </Button>
      </Link>
    ) : null;

  return (
    <div className="min-h-[100dvh] bg-background text-foreground" data-testid="home-page">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <img src="/vispix.png" alt="" className="h-8 w-8 rounded-lg" />
            <span className="text-lg font-semibold tracking-tight">Vispix</span>
          </Link>
          <nav className="flex items-center gap-2 sm:gap-3">
            <a href="#pricing" className="hidden px-2 text-sm text-muted-foreground hover:text-foreground sm:inline">
              Pricing
            </a>
            <ThemeToggle />
            <Link href="/sign-in">
              <Button variant="ghost" className="rounded-full" data-testid="sign-in-btn">Sign in</Button>
            </Link>
            {registrationEnabled && (
              <Link href="/sign-up">
                <Button className="rounded-full" data-testid="sign-up-btn">Start free</Button>
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main>
        {/* Hero: asymmetric split, copy left, a wall of event photography right. */}
        <section className="mx-auto grid max-w-7xl items-center gap-12 px-4 pb-16 pt-12 sm:px-6 md:pt-20 lg:grid-cols-[1.05fr_1fr] lg:gap-16 lg:pb-24">
          <Reveal>
            <h1 className="font-heading pb-1 text-5xl font-bold leading-[1.1] tracking-tight md:text-6xl">
              Every event photo,
              <br />
              <span className="italic text-primary">ready when you are.</span>
            </h1>
            <p className="mt-6 max-w-[34ch] text-lg leading-relaxed text-muted-foreground">
              Upload the whole shoot. Find any shot by describing it, clear rights, and build graphics your team can post.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              {startFree("home-sign-up-btn") ?? (
                <p className="text-sm text-muted-foreground" data-testid="registration-disabled-msg">
                  Registration is by invitation only. Contact your administrator to get access.
                </p>
              )}
              <Link href="/sign-in">
                <Button size="lg" variant="outline" className="rounded-full px-7" data-testid="home-sign-in-btn">
                  Sign in
                </Button>
              </Link>
            </div>
          </Reveal>

          {/* Explicit placement: one large frame, two tall, one wide. */}
          <div
            className="grid aspect-square gap-3 sm:gap-4"
            style={{
              gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
              gridTemplateRows: "repeat(6, minmax(0, 1fr))",
              gridTemplateAreas: '"a a a a b b" "a a a a b b" "a a a a b b" "a a a a c c" "d d d d c c" "d d d d c c"',
            }}
          >
            {[
              { seed: "hero-podium", area: "a", w: 900, h: 900, d: 0.05 },
              { seed: "hero-draw", area: "b", w: 450, h: 680, d: 0.15 },
              { seed: "hero-crowd", area: "c", w: 450, h: 680, d: 0.25 },
              { seed: "hero-team", area: "d", w: 900, h: 450, d: 0.35 },
            ].map((p) => (
              <motion.img
                key={p.seed}
                src={photo(p.seed, p.w, p.h)}
                alt=""
                width={p.w}
                height={p.h}
                loading={p.d < 0.1 ? "eager" : "lazy"}
                style={{ gridArea: p.area }}
                className="h-full w-full rounded-2xl object-cover"
                initial={reduce ? false : { opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.8, delay: p.d, ease }}
              />
            ))}
          </div>
        </section>

        {/* The search, shown rather than described. */}
        <section className="border-y border-border bg-card/40">
          <div className="mx-auto max-w-4xl px-4 py-20 sm:px-6 md:py-24">
            <Reveal>
              <h2 className="font-heading text-3xl font-bold tracking-tight md:text-4xl">Describe it. Vispix finds it.</h2>
              <p className="mt-4 max-w-[60ch] text-muted-foreground">
                Every upload gets an AI description, so plain language works. Exact filenames and photo IDs come up first.
              </p>
            </Reveal>
            <Reveal delay={0.1} className="mt-10">
              <CyclingQuery />
              <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-6">
                {["r1", "r2", "r3", "r4", "r5", "r6"].map((s, i) => (
                  <img
                    key={s}
                    src={photo(`result-${s}`, 300, 300)}
                    alt=""
                    width={300}
                    height={300}
                    loading="lazy"
                    className={`aspect-square w-full rounded-xl object-cover ${i === 0 ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""}`}
                  />
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        {/* What the library does for a team: five capabilities, five cells. */}
        <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 md:py-28">
          <Reveal>
            <h2 className="max-w-[18ch] font-heading text-3xl font-bold tracking-tight md:text-4xl">
              A library that does the busywork.
            </h2>
          </Reveal>
          <div className="mt-12 grid gap-4 md:grid-cols-6 md:grid-rows-[auto_auto]">
            <Reveal className="md:col-span-4">
              <div className="relative h-full min-h-[320px] overflow-hidden rounded-3xl">
                <img src={photo("bento-triage", 1200, 700)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/35 to-transparent" />
                <div className="relative flex h-full flex-col justify-end p-7 text-white">
                  <CopyCheck className="h-6 w-6" aria-hidden />
                  <p role="heading" aria-level={3} className="mt-3 font-heading text-xl font-semibold text-white">Triage happens on upload</p>
                  <p className="mt-1.5 max-w-[46ch] text-sm text-white/80">
                    Descriptions written, quality scored, and duplicates or look-alikes flagged before anyone opens the album.
                  </p>
                </div>
              </div>
            </Reveal>
            <Reveal delay={0.08} className="md:col-span-2">
              <div className="flex h-full flex-col justify-between rounded-3xl bg-primary p-7 text-primary-foreground">
                <Star className="h-6 w-6" aria-hidden />
                <div className="mt-10">
                  <p role="heading" aria-level={3} className="font-heading text-xl font-semibold text-primary-foreground">Decide together</p>
                  <p className="mt-1.5 text-sm text-primary-foreground/85">Everyone rates in place. The best shots rise without a single email thread.</p>
                </div>
              </div>
            </Reveal>
            <Reveal delay={0.04} className="md:col-span-2">
              <div className="h-full rounded-3xl border border-border bg-card p-7">
                <ShieldCheck className="h-6 w-6 text-primary" aria-hidden />
                <h3 className="mt-3 text-xl font-semibold">Rights on every photo</h3>
                <p className="mt-1.5 text-sm text-muted-foreground">Record what each photo can be used for, then search only what you can use.</p>
              </div>
            </Reveal>
            <Reveal delay={0.08} className="md:col-span-2">
              <div className="h-full rounded-3xl border border-border bg-card p-7">
                <Users className="h-6 w-6 text-primary" aria-hidden />
                <h3 className="mt-3 text-xl font-semibold">Every shot of someone</h3>
                <p className="mt-1.5 text-sm text-muted-foreground">Tag people once and pull up every photo of an athlete in one click.</p>
              </div>
            </Reveal>
            <Reveal delay={0.12} className="md:col-span-2">
              <div className="h-full rounded-3xl bg-foreground p-7 text-background">
                <Bot className="h-6 w-6" aria-hidden />
                <p role="heading" aria-level={3} className="mt-3 font-heading text-xl font-semibold text-background">Ask from Claude</p>
                <p className="mt-1.5 text-sm text-background/75">
                  Connect your AI tools over MCP: “three hero shots from nationals, cleared for social.”
                </p>
              </div>
            </Reveal>
          </div>
        </section>

        {/* Shared drive vs Vispix: two columns, no table rules. */}
        <section className="mx-auto max-w-5xl px-4 py-20 sm:px-6 md:py-28">
          <Reveal>
            <h2 className="font-heading text-3xl font-bold tracking-tight md:text-4xl">Why not just a shared drive?</h2>
          </Reveal>
          <div className="mt-12 grid gap-10 md:grid-cols-2">
            <Reveal className="space-y-5">
              <p className="text-sm font-medium text-muted-foreground">On a shared drive</p>
              {DRIVE_VS.map((row) => (
                <p key={row.drive} className="flex items-start gap-3 text-muted-foreground">
                  <X className="mt-1 h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden />
                  {row.drive}
                </p>
              ))}
            </Reveal>
            <Reveal delay={0.1} className="space-y-5 rounded-3xl bg-primary/5 p-7 md:-my-7">
              <p className="text-sm font-medium text-primary">In Vispix</p>
              {DRIVE_VS.map((row) => (
                <p key={row.vispix} className="flex items-start gap-3 font-medium">
                  <Check className="mt-1 h-4 w-4 shrink-0 text-primary" aria-hidden />
                  {row.vispix}
                </p>
              ))}
            </Reveal>
          </div>
        </section>

        {/* Pricing, from the shared plan display. */}
        <section id="pricing" className="scroll-mt-20 border-t border-border bg-card/40">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 md:py-24">
            <Reveal>
              <h2 className="font-heading text-3xl font-bold tracking-tight md:text-4xl">Priced by storage, not seats.</h2>
              <p className="mt-3 text-muted-foreground">Invite your whole team on any plan. Every plan includes AI descriptions, search, ratings and collections.</p>
            </Reveal>
            <div className="mt-12 grid items-stretch gap-4 md:grid-cols-[1fr_1.2fr_1fr]">
              {PLAN_ORDER.map((id, i) => {
                const plan = PLAN_CARDS[id];
                const highlight = id === "pro";
                return (
                  <Reveal key={id} delay={i * 0.06}>
                    <div
                      className={`flex h-full flex-col rounded-3xl p-7 ${highlight ? "bg-primary text-primary-foreground" : "border border-border bg-background"}`}
                      data-testid={`home-plan-${id}`}
                    >
                      <p role="heading" aria-level={3} className={`font-heading font-semibold ${highlight ? "text-primary-foreground" : "text-foreground"}`}>{plan.label}</p>
                      <p className="mt-2 text-3xl font-bold tracking-tight">{plan.priceDisplay}</p>
                      <p className={`mt-3 flex-1 text-sm ${highlight ? "text-primary-foreground/85" : "text-muted-foreground"}`}>{plan.blurb}</p>
                      <div className="mt-6">
                        {id === "enterprise" ? (
                          <a href={ENTERPRISE_CONTACT}>
                            <Button variant="outline" className="w-full rounded-full">Contact us</Button>
                          </a>
                        ) : registrationEnabled ? (
                          <Link href="/sign-up">
                            <Button variant={highlight ? "secondary" : "outline"} className="w-full rounded-full">
                              Start free
                            </Button>
                          </Link>
                        ) : (
                          <Button variant="outline" className="w-full rounded-full" disabled>
                            By invitation
                          </Button>
                        )}
                      </div>
                    </div>
                  </Reveal>
                );
              })}
            </div>
          </div>
        </section>

        {registrationEnabled && (
          <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 md:py-28">
            <Reveal className="flex flex-col items-start justify-between gap-8 md:flex-row md:items-end">
              <h2 className="max-w-[16ch] font-heading text-4xl font-bold leading-[1.1] tracking-tight md:text-5xl">
                Bring this season’s photos in.
              </h2>
              <div className="flex flex-col items-start gap-3">
                {startFree("home-final-sign-up-btn")}
                <p className="text-sm text-muted-foreground">2 GB free, no card required.</p>
              </div>
            </Reveal>
          </section>
        )}
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-2">
            <img src="/vispix.png" alt="" className="h-5 w-5 rounded" />
            <span>© {new Date().getFullYear()} Vispix</span>
          </div>
          <div className="flex items-center gap-5">
            <a href="#pricing" className="hover:text-foreground">Pricing</a>
            <a href={ENTERPRISE_CONTACT} className="hover:text-foreground">Contact us</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
