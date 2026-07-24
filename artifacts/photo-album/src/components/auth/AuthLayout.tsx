import { Search, Star, ShieldCheck, Bot, Zap } from "lucide-react";

const POINTS = [
  { icon: Search, text: "Search photos by describing them" },
  { icon: Star, text: "Team ratings decide the best shots" },
  { icon: ShieldCheck, text: "Usage rights tracked per photo" },
  { icon: Bot, text: "Answerable by your AI tools (MCP)" },
];

// Split auth layout (#157): the form on the left, a brand/value panel on the
// right so the sign-in / sign-up funnel reads as one product, not a stock auth
// form. The panel is hidden below lg so mobile just shows the form.
export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-[100dvh] lg:grid-cols-2">
      <div className="flex items-center justify-center bg-background px-4 py-10">
        <div className="w-full max-w-[440px]">{children}</div>
      </div>

      <div className="relative hidden overflow-hidden bg-gradient-to-br from-primary/15 via-background to-background lg:flex lg:flex-col lg:justify-center lg:px-14">
        <div className="max-w-md">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
            <Zap className="h-3.5 w-3.5 text-primary" />
            Marketing asset superpowers
          </span>
          <h2 className="mt-5 text-3xl font-bold leading-tight text-foreground">
            Give your marketing photos superpowers.
          </h2>
          <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
            AI describes and de-duplicates every shot, plain-language search finds it, and your team
            rates the best — so the right photos ship faster.
          </p>
          <ul className="mt-8 space-y-3">
            {POINTS.map((p) => (
              <li key={p.text} className="flex items-center gap-3 text-sm text-foreground">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <p.icon className="h-4 w-4 text-primary" />
                </span>
                {p.text}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
