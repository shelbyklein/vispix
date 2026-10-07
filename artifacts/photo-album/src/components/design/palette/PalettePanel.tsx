import { useEffect, useState } from "react";
import type { PlatformTheme } from "@workspace/api-zod/theme";
import { useCreatePalette, useDeletePalette, usePalettes, useUpdatePalette, type SavedPalette } from "@workspace/api-client-react";
import { ChevronDown, Eye, Palette as PaletteIcon, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { hslStringToHex } from "../color-utils";
import {
  COLOR_VISIONS,
  HARMONY_RULES,
  harmony,
  moveOnWheel,
  wheelToHex,
  type ColorVision,
  type HarmonyRule,
  type RoleAssignment,
  type WheelPoint,
} from "./engine";
import { hslOf, normalizeHex } from "./color-math";
import { ColorWheel } from "./ColorWheel";
import { ImageSource } from "./ImageSource";
import { Roles } from "./Roles";
import { RuleIcon } from "./RuleIcon";
import { SavedPalettes } from "./SavedPalettes";
import { PaletteStrip, Swatches } from "./Swatches";

type Tab = "wheel" | "base" | "image";

export function PalettePanel({
  draft,
  onApplyRoles,
}: {
  draft: PlatformTheme;
  onApplyRoles: (roles: RoleAssignment) => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<Tab>("wheel");
  const [rule, setRule] = useState<HarmonyRule | null>("analogous");
  const [swatches, setSwatches] = useState<string[]>(() => harmony(hslStringToHex(draft.light.primary).toUpperCase(), "analogous"));
  const [selected, setSelected] = useState(0);
  const [vision, setVision] = useState<ColorVision>("normal");
  const [roles, setRoles] = useState<RoleAssignment>({});
  const [name, setName] = useState("");
  const [loadedId, setLoadedId] = useState<number | null>(null);
  const [baseText, setBaseText] = useState(swatches[0]);

  // Keep the base field in step with the palette (wheel drags, opened palettes)
  // without rewriting what is being typed.
  useEffect(() => {
    setBaseText((t) => (normalizeHex(t) === swatches[0] ? t : swatches[0]));
  }, [swatches]);

  const list = usePalettes();
  const create = useCreatePalette();
  const update = useUpdatePalette();
  const remove = useDeletePalette();

  const ruleLabel = HARMONY_RULES.find((r) => r.rule === rule)?.label;
  const visionLabel = COLOR_VISIONS.find((v) => v.vision === vision)?.label;

  function setPalette(next: string[], nextRule: HarmonyRule | null) {
    setSwatches(next);
    setRule(nextRule);
    setSelected((s) => Math.min(s, next.length - 1));
  }

  function chooseRule(r: HarmonyRule) {
    setPalette(harmony(swatches[0], r), r);
    setSelected(0);
  }

  function onWheelMove(index: number, to: WheelPoint) {
    if (rule) {
      setSwatches(moveOnWheel(swatches, rule, index, to));
    } else {
      // A palette taken from an image has no rule: each swatch moves alone.
      setSwatches(swatches.map((hex, i) => (i === index ? wheelToHex(to, hslOf(hex).l) : hex)));
    }
  }

  function applyBase(hex: string) {
    const ok = normalizeHex(hex);
    if (!ok) return;
    setPalette(harmony(ok, rule ?? "analogous"), rule ?? "analogous");
  }

  async function onSave(asNew: boolean) {
    const input = { name: name.trim(), swatches, roles, harmony: rule };
    if (!input.name) {
      toast({ title: "Name the palette first", variant: "destructive" });
      return;
    }
    try {
      if (loadedId !== null && !asNew) {
        await update.mutateAsync({ id: loadedId, input });
        toast({ title: "Palette updated" });
      } else {
        const saved = await create.mutateAsync(input);
        setLoadedId(saved.id);
        toast({ title: "Palette saved" });
      }
    } catch (e) {
      toast({ title: "Could not save palette", description: (e as Error).message, variant: "destructive" });
    }
  }

  function onOpenSaved(p: SavedPalette) {
    setPalette(p.swatches, p.harmony);
    setSelected(0);
    setRoles(p.roles);
    setName(p.name);
    setLoadedId(p.id);
    setTab(p.harmony ? "wheel" : "image");
  }

  async function onDelete(p: SavedPalette) {
    try {
      await remove.mutateAsync(p.id);
      if (loadedId === p.id) setLoadedId(null);
      toast({ title: "Palette deleted" });
    } catch (e) {
      toast({ title: "Could not delete palette", description: (e as Error).message, variant: "destructive" });
    }
  }

  const saving = create.isPending || update.isPending;

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section className="rounded-xl border border-border bg-card" data-testid="palette-panel">
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 rounded-xl p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="palette-toggle">
          <span className="flex items-center gap-2">
            <PaletteIcon className="h-4 w-4" aria-hidden />
            <span className="text-sm font-semibold">Palette</span>
            <span className="hidden text-xs text-muted-foreground sm:inline">Pick colors from a wheel, a base color or an image, then use them as the theme.</span>
          </span>
          <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-6 border-t border-border p-4">
            <div className="grid gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
              <div className="space-y-4">
                <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
                  <TabsList>
                    <TabsTrigger value="wheel" data-testid="palette-tab-wheel">Color wheel</TabsTrigger>
                    <TabsTrigger value="base" data-testid="palette-tab-base">Base color</TabsTrigger>
                    <TabsTrigger value="image" data-testid="palette-tab-image">Image</TabsTrigger>
                  </TabsList>
                  <TabsContent value="wheel" className="mt-4">
                    <ColorWheel swatches={swatches} selected={selected} onSelect={setSelected} onMove={onWheelMove} />
                  </TabsContent>
                  <TabsContent value="base" className="mt-4 space-y-3">
                    <label htmlFor="palette-base-hex" className="text-sm font-medium">Base color</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={normalizeHex(baseText)?.toLowerCase() ?? swatches[0].toLowerCase()}
                        onChange={(e) => {
                          setBaseText(e.target.value.toUpperCase());
                          applyBase(e.target.value);
                        }}
                        className="h-10 w-12 cursor-pointer rounded-md border border-input bg-background p-1"
                        aria-label="Pick the base color"
                        data-testid="palette-base-picker"
                      />
                      <Input
                        id="palette-base-hex"
                        value={baseText}
                        onChange={(e) => {
                          setBaseText(e.target.value);
                          if (normalizeHex(e.target.value)) applyBase(e.target.value);
                        }}
                        spellCheck={false}
                        autoComplete="off"
                        className="w-32 font-mono"
                        aria-invalid={!normalizeHex(baseText)}
                        data-testid="palette-base-hex"
                      />
                    </div>
                    <p className={`text-xs ${normalizeHex(baseText) ? "text-muted-foreground" : "text-destructive"}`}>
                      {normalizeHex(baseText) ? "The harmony rule below builds the other four from this color." : "Use a hex color like #E8643C."}
                    </p>
                  </TabsContent>
                  <TabsContent value="image" className="mt-4">
                    <ImageSource
                      onExtracted={(colors) => {
                        setPalette(colors, null);
                        setSelected(0);
                      }}
                    />
                  </TabsContent>
                </Tabs>

                <div className="space-y-2">
                  <div className="text-sm">
                    <span className="text-muted-foreground">Color harmonies: </span>
                    <span className="font-medium" data-testid="palette-rule-name">{ruleLabel ?? "None (from image)"}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Color harmony">
                    {HARMONY_RULES.map(({ rule: r, label }) => (
                      <button
                        key={r}
                        type="button"
                        role="radio"
                        aria-checked={rule === r}
                        aria-label={label}
                        title={label}
                        onClick={() => chooseRule(r)}
                        className={`flex h-9 w-9 items-center justify-center rounded-lg border outline-none focus-visible:ring-2 focus-visible:ring-ring ${rule === r ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                        data-testid={`palette-rule-${r}`}
                      >
                        <RuleIcon rule={r} />
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="min-w-0 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">Swatches</h3>
                  <div className="flex items-center gap-1.5">
                    <Eye className="h-4 w-4 text-muted-foreground" aria-hidden />
                    <Select value={vision} onValueChange={(v) => setVision(v as ColorVision)}>
                      <SelectTrigger className="h-8 w-[13rem] text-xs" aria-label="Color-vision preview" data-testid="palette-vision">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {COLOR_VISIONS.map((v) => (
                          <SelectItem key={v.vision} value={v.vision}>{v.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <Swatches swatches={swatches} selected={selected} onSelect={setSelected} vision={vision} />
                {vision !== "normal" && (
                  <p className="text-xs text-muted-foreground" data-testid="palette-vision-note">
                    Simulation of {visionLabel?.toLowerCase()}: an approximation, not a medical test. Hex values and copy still use the real colors.
                  </p>
                )}
                <PaletteStrip swatches={swatches} vision={vision} />

                <div className="space-y-2 rounded-lg border border-border p-3">
                  <label htmlFor="palette-name" className="text-sm font-medium">Palette name</label>
                  <div className="flex flex-wrap gap-2">
                    <Input id="palette-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Sunset" className="min-w-0 flex-1" data-testid="palette-name" />
                    <Button type="button" size="sm" disabled={saving} onClick={() => void onSave(false)} data-testid="palette-save">
                      <Save className="mr-1.5 h-3.5 w-3.5" /> {loadedId !== null ? "Update" : "Save palette"}
                    </Button>
                    {loadedId !== null && (
                      <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => void onSave(true)}>Save as new</Button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-6 border-t border-border pt-6 lg:grid-cols-2">
              <Roles
                swatches={swatches}
                roles={roles}
                onRolesChange={setRoles}
                draft={draft}
                onApply={(r) => {
                  onApplyRoles(r);
                  toast({ title: "Applied to the draft theme", description: "Check the preview, then Save." });
                }}
              />
              <SavedPalettes
                palettes={list.data}
                isLoading={list.isLoading}
                error={(list.error as Error | null) ?? null}
                loadedId={loadedId}
                onOpen={onOpenSaved}
                onDelete={onDelete}
              />
            </div>
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
