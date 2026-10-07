import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { AlertTriangle, CheckCircle2, XCircle, Camera } from "lucide-react";

/** Real app components, styled by whatever tokens are live on the page. */
export function ThemePreview() {
  return (
    <div className="space-y-5" data-testid="theme-preview">
      <section className="space-y-2">
        <h1 className="text-2xl font-bold">Spring Open photo shortlist</h1>
        <h2 className="text-lg font-semibold">Selected for the program</h2>
        <p className="text-sm text-muted-foreground max-w-prose">
          Body text sample. Vispix helps teams choose the right photos for marketing, with ratings, rights and
          shortlists in one place. Hover the buttons to check their states.
        </p>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Buttons</h3>
        <div className="flex flex-wrap gap-2">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
          <Button size="sm">Small</Button>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Badges and status</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="destructive">Destructive</Badge>
          <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2.5 py-0.5 text-xs font-medium text-warning">
            <AlertTriangle className="h-3 w-3" /> Rights unknown
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success">
            <CheckCircle2 className="h-3 w-3" /> Cleared
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive">
            <XCircle className="h-3 w-3" /> Failed
          </span>
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Camera className="h-4 w-4 text-primary" /> Archer 3
            </CardTitle>
            <CardDescription>spring_open_archer_03.jpg</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="h-20 rounded-md bg-muted" />
            <p className="text-muted-foreground">Card with muted media area and secondary text.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Inputs</CardTitle>
            <CardDescription>Focus a field to see the ring.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Input placeholder="Search photos" />
            <Input defaultValue="USA Archery" />
            <div className="rounded-md border border-border bg-popover p-2 text-sm text-popover-foreground shadow-md">
              Popover / menu surface
            </div>
          </CardContent>
        </Card>
      </div>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Chart colors</h3>
        <div className="flex gap-2">
          {[1, 2, 3, 4, 5].map((n) => (
            <div
              key={n}
              className="h-10 flex-1 rounded-md"
              style={{ background: `hsl(var(--chart-${n}))` }}
              title={`chart-${n}`}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
