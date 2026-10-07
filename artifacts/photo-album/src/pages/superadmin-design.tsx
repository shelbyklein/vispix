import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ADOBE_FONTS,
  ADOBE_PROJECT_PATTERN,
  COLOR_TOKENS,
  FONT_CHOICES,
  themeToCss,
  type ColorTokenKey,
  type FontChoice,
  type PlatformTheme,
} from "@workspace/api-zod/theme";
import {
  usePlatformTheme,
  useSavePlatformTheme,
  useResetPlatformTheme,
} from "@workspace/api-client-react";
import { Palette, Moon, Sun, Copy, Save, Undo2, RotateCcw } from "lucide-react";
import { AdminSectionShell } from "@/components/admin/AdminSectionShell";
import { ColorTokenRow } from "@/components/design/ColorTokenRow";
import { formatHsl, parseHsl } from "@/components/design/color-utils";
import { ContrastChecks, contrastFailures } from "@/components/design/ContrastChecks";
import { DesignReference } from "@/components/design/DesignReference";
import { ThemePreview } from "@/components/design/ThemePreview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useTheme } from "@/contexts/ThemeContext";

const PREVIEW_STYLE_ID = "theme-preview";
const PICKER_FONTS_ID = "theme-picker-fonts";
const GROUPS = [...new Set(COLOR_TOKENS.map((t) => t.group))];

const PRIMARY_FOLLOWERS: ColorTokenKey[] = ["ring", "sidebar-primary", "sidebar-ring", "chart-1"];
// Brand-tinted tokens: lighter or darker shades of the brand color. They take
// on a new brand hue (keeping their own saturation and lightness) while they
// still share the old one.
const PRIMARY_HUE_FOLLOWERS: ColorTokenKey[] = [
  "accent", "accent-foreground", "sidebar-accent", "sidebar-accent-foreground", "heading-primary",
];

function setPreviewStyle(css: string | null) {
  let el = document.getElementById(PREVIEW_STYLE_ID);
  if (css === null) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = PREVIEW_STYLE_ID;
    document.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

/** Re-fetch /api/theme.css by changing the link's cache-busting query. */
function refreshThemeLink() {
  const link = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"][href^="/api/theme.css"]');
  if (link) link.href = `/api/theme.css?v=${Date.now()}`;
}

// Field by field, not JSON.stringify: the saved theme comes back from a jsonb
// column with its keys reordered.
function sameTheme(a: PlatformTheme, b: PlatformTheme) {
  return (
    COLOR_TOKENS.every((t) => a.light[t.key] === b.light[t.key] && a.dark[t.key] === b.dark[t.key]) &&
    a.fonts.body === b.fonts.body &&
    a.fonts.heading === b.fonts.heading &&
    a.headingWeight === b.headingWeight &&
    a.buttonWeight === b.buttonWeight &&
    a.adobeFontsProject === b.adobeFontsProject &&
    a.radius === b.radius &&
    a.shadowStrength === b.shadowStrength
  );
}

function pickerFontsUrl() {
  // Adobe fonts have no Google family; Sofia Sans (their fallback) is in the list.
  const families = FONT_CHOICES.filter((f) => !ADOBE_FONTS.has(f)).map((f) => `family=${f.replace(/ /g, "+")}:wght@400;600`).join("&");
  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}

function FontSelect({
  label,
  value,
  onChange,
  testId,
  adobeProject,
}: {
  label: string;
  value: FontChoice;
  onChange: (f: FontChoice) => void;
  testId: string;
  adobeProject: string | null;
}) {
  const face = (f: string) => (ADOBE_FONTS.has(f) ? `"${f}", "Sofia Sans"` : `"${f}"`);
  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium">{label}</div>
      <Select value={value} onValueChange={(v) => onChange(v as FontChoice)}>
        <SelectTrigger data-testid={testId} style={{ fontFamily: face(value) }}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FONT_CHOICES.map((f) => (
            <SelectItem key={f} value={f} style={{ fontFamily: face(f) }}>
              {f}
              {ADOBE_FONTS.has(f) ? " (Adobe Fonts)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {ADOBE_FONTS.has(value) && !adobeProject && (
        <p className="text-xs text-muted-foreground" data-testid={`${testId}-adobe-hint`}>
          {value} is an Adobe Fonts font: showing Sofia Sans until an Adobe Fonts project is set.
        </p>
      )}
    </div>
  );
}

const WEIGHTS = [300, 400, 500, 600, 700, 800];

function WeightSelect({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: number;
  onChange: (w: number) => void;
  testId: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium">{label}</div>
      <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger data-testid={testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {[...new Set([...WEIGHTS, value])].sort((a, b) => a - b).map((w) => (
            <SelectItem key={w} value={String(w)}>
              {w}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function DesignEditor() {
  const { toast } = useToast();
  const { theme: appMode, setTheme: setAppMode } = useTheme();
  const { data, isLoading, error } = usePlatformTheme();
  const save = useSavePlatformTheme();
  const reset = useResetPlatformTheme();

  const baseline = useMemo(() => (data ? (data.theme ?? data.defaults) : null), [data]);
  const [draft, setDraft] = useState<PlatformTheme | null>(null);
  const [mode, setMode] = useState<"light" | "dark">(appMode);
  const [confirmReset, setConfirmReset] = useState(false);
  const originalMode = useRef(appMode);

  // Seed the draft once the saved theme arrives (and after save/reset change the baseline).
  useEffect(() => {
    if (baseline) setDraft((d) => d ?? structuredClone(baseline));
  }, [baseline]);

  const dirty = !!(draft && baseline && !sameTheme(draft, baseline));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Live preview: the whole app picks up the draft through one style tag.
  useEffect(() => {
    if (draft) setPreviewStyle(themeToCss(draft));
  }, [draft]);
  useEffect(() => {
    const restore = originalMode.current;
    return () => {
      setPreviewStyle(null);
      setAppMode(restore);
      document.getElementById(PICKER_FONTS_ID)?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The preview follows the mode being edited.
  useEffect(() => {
    if (appMode !== mode) setAppMode(mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Fonts for the pickers (each option renders in its own face).
  useEffect(() => {
    if (document.getElementById(PICKER_FONTS_ID)) return;
    const link = document.createElement("link");
    link.id = PICKER_FONTS_ID;
    link.rel = "stylesheet";
    link.href = pickerFontsUrl();
    document.head.appendChild(link);
  }, []);

  // Leaving with unsaved changes: browser unload and in-app link clicks.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    const onClick = (e: MouseEvent) => {
      if (!dirtyRef.current || e.defaultPrevented) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.origin !== window.location.origin) return;
      if (a.pathname === window.location.pathname) return;
      if (!window.confirm("You have unsaved theme changes. Leave this page and discard them?")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  // Editing the brand color carries the tokens that mirror it (focus rings,
  // the sidebar's active item, the first chart color) as long as they still
  // match it; once one is set to something else it stays independent.
  const setColor = useCallback(
    (key: ColorTokenKey, value: string) =>
      setDraft((d) => {
        if (!d) return d;
        const next = { ...d[mode], [key]: value };
        if (key === "primary") {
          for (const follower of PRIMARY_FOLLOWERS) {
            if (d[mode][follower] === d[mode].primary) next[follower] = value;
          }
          const before = parseHsl(d[mode].primary);
          const after = parseHsl(value);
          if (before && after) {
            for (const follower of PRIMARY_HUE_FOLLOWERS) {
              const shade = parseHsl(d[mode][follower]);
              if (shade && shade.h === before.h) next[follower] = formatHsl({ ...shade, h: after.h });
            }
          }
        }
        return { ...d, [mode]: next };
      }),
    [mode],
  );

  if (isLoading || !draft || !data) {
    if (error) {
      return <p className="text-sm text-destructive">Could not load the theme: {(error as Error).message}</p>;
    }
    return <Skeleton className="h-96 w-full rounded-xl" />;
  }

  const custom = data.theme !== null;
  const adobeInvalid = draft.adobeFontsProject !== null && !ADOBE_PROJECT_PATTERN.test(draft.adobeFontsProject);
  const colors = draft[mode];
  const failures = contrastFailures(colors);

  async function onSave() {
    if (!draft) return;
    if (adobeInvalid) {
      toast({ title: "Adobe Fonts project ID is not valid", description: "Use 7-12 lowercase letters or digits.", variant: "destructive" });
      return;
    }
    try {
      await save.mutateAsync(draft);
      refreshThemeLink();
      toast({ title: "Theme saved", description: "Every page uses it on its next load." });
    } catch (e) {
      toast({ title: "Could not save theme", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function onReset() {
    try {
      const state = await reset.mutateAsync();
      setDraft(structuredClone(state.defaults));
      refreshThemeLink();
      toast({ title: "Reset to the built-in theme" });
    } catch (e) {
      toast({ title: "Could not reset theme", description: (e as Error).message, variant: "destructive" });
    } finally {
      setConfirmReset(false);
    }
  }

  async function onExport() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(themeToCss(draft));
      toast({ title: "CSS copied to clipboard" });
    } catch {
      toast({ title: "Could not copy", description: "Clipboard access was denied.", variant: "destructive" });
    }
  }

  return (
    <div className="space-y-6">
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-3"
        data-testid="design-toolbar"
      >
        <div className="text-sm" data-testid="design-status">
          {custom ? (
            <>
              <span className="font-medium">Custom theme</span>
              <span className="text-muted-foreground">
                {" · saved "}
                {data.updatedAt ? new Date(data.updatedAt).toLocaleString() : ""}
              </span>
            </>
          ) : (
            <span className="font-medium">Using built-in theme</span>
          )}
          {dirty && <span className="ml-2 rounded-full bg-warning/10 px-2 py-0.5 text-xs text-warning-foreground">Unsaved changes</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onExport} data-testid="design-export">
            <Copy className="mr-1.5 h-3.5 w-3.5" /> Export CSS
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!custom}
            onClick={() => setConfirmReset(true)}
            data-testid="design-reset"
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset to built-in
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!dirty}
            onClick={() => baseline && setDraft(structuredClone(baseline))}
            data-testid="design-discard"
          >
            <Undo2 className="mr-1.5 h-3.5 w-3.5" /> Discard changes
          </Button>
          <Button size="sm" disabled={!dirty || save.isPending || adobeInvalid} onClick={onSave} data-testid="design-save">
            <Save className="mr-1.5 h-3.5 w-3.5" /> {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Panel title="Editing mode">
            <div className="flex gap-2" role="group" aria-label="Mode being edited">
              <Button
                variant={mode === "light" ? "default" : "outline"}
                size="sm"
                onClick={() => setMode("light")}
                aria-pressed={mode === "light"}
                data-testid="mode-light"
              >
                <Sun className="mr-1.5 h-3.5 w-3.5" /> Light
              </Button>
              <Button
                variant={mode === "dark" ? "default" : "outline"}
                size="sm"
                onClick={() => setMode("dark")}
                aria-pressed={mode === "dark"}
                data-testid="mode-dark"
              >
                <Moon className="mr-1.5 h-3.5 w-3.5" /> Dark
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The whole app previews the {mode} palette while you edit. Colors for the other mode are kept.
            </p>
          </Panel>

          <Panel title="Fonts">
            <FontSelect
              label="Body"
              value={draft.fonts.body}
              onChange={(f) => setDraft({ ...draft, fonts: { ...draft.fonts, body: f } })}
              testId="font-body"
              adobeProject={draft.adobeFontsProject}
            />
            <FontSelect
              label="Headings"
              value={draft.fonts.heading}
              onChange={(f) => setDraft({ ...draft, fonts: { ...draft.fonts, heading: f } })}
              testId="font-heading"
              adobeProject={draft.adobeFontsProject}
            />
            <div className="grid grid-cols-2 gap-3">
              <WeightSelect
                label="Heading weight"
                value={draft.headingWeight}
                onChange={(w) => setDraft({ ...draft, headingWeight: w })}
                testId="heading-weight"
              />
              <WeightSelect
                label="Button weight"
                value={draft.buttonWeight}
                onChange={(w) => setDraft({ ...draft, buttonWeight: w })}
                testId="button-weight"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="adobe-project" className="text-sm font-medium">
                Adobe Fonts project ID
              </label>
              <Input
                id="adobe-project"
                value={draft.adobeFontsProject ?? ""}
                placeholder="e.g. abc1def"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={adobeInvalid}
                onChange={(e) => setDraft({ ...draft, adobeFontsProject: e.target.value.trim() === "" ? null : e.target.value.trim() })}
                data-testid="adobe-project"
              />
              <p className={`text-xs ${adobeInvalid ? "text-destructive" : "text-muted-foreground"}`}>
                {adobeInvalid
                  ? "7-12 lowercase letters or digits (the ID in use.typekit.net/<id>.css)."
                  : "Find it in Adobe Fonts → Web Projects. Needed for Sofia Pro; leave empty to use the fallback."}
              </p>
            </div>
          </Panel>

          <Panel title="Shape">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">Corner radius</span>
                <span className="font-mono text-xs text-muted-foreground">{draft.radius.toFixed(2)}rem</span>
              </div>
              <Slider
                min={0}
                max={1.5}
                step={0.05}
                value={[draft.radius]}
                onValueChange={([v]) => setDraft({ ...draft, radius: Math.round(v * 100) / 100 })}
                aria-label="Corner radius"
                data-testid="radius-slider"
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">Shadow strength</span>
                <span className="font-mono text-xs text-muted-foreground">{draft.shadowStrength.toFixed(2)}×</span>
              </div>
              <Slider
                min={0}
                max={2}
                step={0.05}
                value={[draft.shadowStrength]}
                onValueChange={([v]) => setDraft({ ...draft, shadowStrength: Math.round(v * 100) / 100 })}
                aria-label="Shadow strength"
                data-testid="shadow-slider"
              />
            </div>
          </Panel>

          <Panel title={`Contrast (${mode})`}>
            {failures > 0 && (
              <p className="text-xs text-warning-foreground" data-testid="contrast-summary">
                {failures} pair{failures === 1 ? "" : "s"} below the WCAG AA target. You can still save.
              </p>
            )}
            <ContrastChecks colors={colors} mode={mode} />
          </Panel>

          {GROUPS.map((group) => (
            <Panel key={group} title={`${group} colors (${mode})`}>
              <div className="space-y-2.5">
                {COLOR_TOKENS.filter((t) => t.group === group).map((t) => (
                  <ColorTokenRow
                    key={`${mode}-${t.key}`}
                    tokenKey={t.key}
                    label={t.label}
                    value={colors[t.key]}
                    onChange={(v) => setColor(t.key, v)}
                  />
                ))}
              </div>
            </Panel>
          ))}
        </div>

        <div className="lg:sticky lg:top-4 lg:self-start">
          <div className="rounded-xl border border-border bg-background p-5 shadow-md">
            <ThemePreview />
          </div>
        </div>
      </div>

      <DesignReference />

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset to the built-in theme?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the saved theme. Every page returns to the original look on its next load.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onReset} data-testid="design-reset-confirm">
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function SuperadminDesignPage() {
  return (
    <AdminSectionShell
      title="Design"
      scope="platform"
      icon={Palette}
      description="Edit the platform theme. Changes preview across the whole app; Save applies them for everyone."
    >
      <DesignEditor />
    </AdminSectionShell>
  );
}
