import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

// Compact port of docs/design/vispix-design-map.html (stack, flow, where to
// change what, known gaps), updated for the live theme.
const STACK: [string, string][] = [
  ["Styling", "Tailwind CSS v4, CSS variables in index.css, class-variance-authority, tailwind-merge"],
  ["Components", "shadcn/ui (new-york) on Radix, lucide-react icons, sonner toasts, recharts"],
  ["App", "React 19, Vite 7, TypeScript, wouter routing, lazy-loaded pages"],
  ["Data", "TanStack Query, Orval-generated hooks from the OpenAPI spec"],
];

const FLOW: [string, string][] = [
  ["1 Tokens", "index.css holds HSL values in :root and .dark, e.g. --primary: 222 99% 51%."],
  ["2 Theme link", "/api/theme.css (the saved theme) overrides those variables on every page load."],
  ["3 Bridge", "@theme inline maps each token to a Tailwind color, e.g. --color-primary."],
  ["4 Utilities", "bg-primary, text-muted-foreground, bg-warning/10, rounded-lg."],
  ["5 Primitives and screens", "components/ui/* variants, then pages compose them. Changes here stay local."],
];

const WHERE: [string, string][] = [
  ["Colors, fonts, radius, shadows", "This page (saved in the database), or index.css for the built-in default"],
  ["Heading color and style", "@layer base h1-h6 rules in index.css (override page classes)"],
  ["Buttons, badges, inputs, cards", "src/components/ui/*.tsx (cva variants)"],
  ["Sidebar items and shell", "src/components/layout/AppLayout.tsx"],
  ["Page headers", "Each file in src/pages (no shared component yet)"],
  ["Landing page", "src/pages/home.tsx (public site only)"],
];

const GAPS: [string, string][] = [
  ["Medium", "Page headers are copy-pasted across ~16 pages with mixed sizes; a shared PageHeader would unify them."],
  ["Medium", "Pages set text-foreground on h1, but the base layer forces the heading color, so that class has no effect."],
  ["Low", "Many radius values (full, lg, xl, md, sm, 2xl) with no rule for which surface gets which."],
  ["Low", "Locally edited shadcn primitives (// @replit) make upgrading harder."],
  ["Low", "--app-font-serif (Georgia) is defined but nothing uses it."],
];

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </div>
  );
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="divide-y divide-border rounded-lg border border-border text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="grid gap-1 px-3 py-2 sm:grid-cols-[14rem_1fr]">
          <dt className="font-medium text-foreground">{k}</dt>
          <dd className="text-muted-foreground">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DesignReference() {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border border-border bg-card" data-testid="design-reference">
      <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold">
        Reference: how the design system works
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-5 px-4 pb-4">
        <Block title="Stack">
          <Rows rows={STACK} />
        </Block>
        <Block title="How styling flows">
          <Rows rows={FLOW} />
        </Block>
        <Block title="Where to change what">
          <Rows rows={WHERE} />
        </Block>
        <Block title="Known gaps">
          <Rows rows={GAPS} />
        </Block>
        <p className="text-xs text-muted-foreground">
          Full static map with every component and route: docs/design/vispix-design-map.html in the repository.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
