import { useMemo } from "react";
import { COLOR_TOKENS, type PlatformTheme } from "@workspace/api-zod/theme";
import { Check, Sparkles, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { contrastRatio, deriveTheme, PALETTE_ROLES, type PaletteRole, type RoleAssignment } from "./engine";
import { readableOn } from "./color-math";
import { suggestRoles } from "./suggest-roles";

function changedTokens(draft: PlatformTheme, roles: RoleAssignment) {
  if (Object.keys(roles).length === 0) return { light: [], dark: [], error: null as string | null };
  try {
    const next = deriveTheme(draft, roles);
    const diff = (mode: "light" | "dark") => COLOR_TOKENS.filter((t) => next[mode][t.key] !== draft[mode][t.key]).map((t) => t.label);
    return { light: diff("light"), dark: diff("dark"), error: null };
  } catch (e) {
    return { light: [], dark: [], error: e instanceof Error ? e.message : "Could not derive the theme." };
  }
}

function TokenList({ label, names }: { label: string; names: string[] }) {
  return (
    <p className="text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{label}:</span>{" "}
      {names.length === 0 ? "no changes" : `${names.length} token${names.length === 1 ? "" : "s"}: ${names.slice(0, 6).join(", ")}${names.length > 6 ? `, +${names.length - 6} more` : ""}`}
    </p>
  );
}

export function Roles({
  swatches,
  roles,
  onRolesChange,
  draft,
  onApply,
}: {
  swatches: string[];
  roles: RoleAssignment;
  onRolesChange: (roles: RoleAssignment) => void;
  draft: PlatformTheme;
  onApply: (roles: RoleAssignment) => void;
}) {
  const changes = useMemo(() => changedTokens(draft, roles), [draft, roles]);
  const assigned = Object.keys(roles).length;
  const bg = roles.background;
  const bg2 = roles["secondary-background"];
  // Relative luminance from contrast against black: (L + 0.05) / 0.05.
  const lum = (hex: string) => contrastRatio(hex, "#000000") * 0.05 - 0.05;
  const MID = 0.18; // about where black and white text contrast equally
  const splitLuminance = !!bg && !!bg2 && lum(bg) > MID !== lum(bg2) > MID;

  function assign(role: PaletteRole, hex: string | null) {
    const next = { ...roles };
    if (hex) next[role] = hex;
    else delete next[role];
    onRolesChange(next);
  }

  return (
    <div className="space-y-3" data-testid="palette-roles">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Use in the theme</h3>
          <p className="text-xs text-muted-foreground">Assign swatches to roles. Text colors and dark mode are derived for contrast.</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => onRolesChange(suggestRoles(swatches))} data-testid="palette-suggest">
          <Wand2 className="mr-1.5 h-3.5 w-3.5" /> Suggest
        </Button>
      </div>

      <ul className="divide-y divide-border rounded-lg border border-border">
        {PALETTE_ROLES.map(({ role, label, description }) => {
          const current = roles[role];
          return (
            <li key={role} className="space-y-1.5 px-3 py-2" data-testid={`palette-role-${role}`}>
              <div className="min-w-0">
                <div className="text-sm font-medium">{label}</div>
                <div className="text-xs text-muted-foreground">{description}</div>
              </div>
              <div className="flex items-center gap-1.5" role="radiogroup" aria-label={`${label} color`}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={!current}
                  onClick={() => assign(role, null)}
                  className={`h-7 rounded-md border px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring ${!current ? "border-foreground bg-muted font-medium" : "border-border text-muted-foreground hover:bg-muted"}`}
                >
                  Keep current
                </button>
                {swatches.map((hex, i) => (
                  <button
                    key={`${hex}-${i}`}
                    type="button"
                    role="radio"
                    aria-checked={current === hex}
                    aria-label={`${label}: ${hex}`}
                    onClick={() => assign(role, hex)}
                    className={`flex h-7 w-7 items-center justify-center rounded-md outline-none ring-offset-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring ${current === hex ? "ring-2 ring-foreground" : "ring-1 ring-border"}`}
                    style={{ backgroundColor: hex, color: readableOn(hex) }}
                  >
                    {current === hex && <Check className="h-3.5 w-3.5" />}
                  </button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="space-y-1" aria-live="polite">
        {splitLuminance && (
          <p className="text-xs text-warning-foreground" data-testid="palette-role-warning">
            The page and secondary backgrounds sit on opposite sides of mid-tone (one light, one dark), so secondary text may not reach 4.5:1 on both. Pick two light or two dark swatches for the best contrast.
          </p>
        )}
        {changes.error ? (
          <p className="text-xs text-destructive">{changes.error}</p>
        ) : assigned === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing assigned yet.</p>
        ) : (
          <>
            <TokenList label="Light mode" names={changes.light} />
            <TokenList label="Dark mode" names={changes.dark} />
          </>
        )}
      </div>

      <Button type="button" size="sm" disabled={assigned === 0} onClick={() => onApply(roles)} data-testid="palette-apply">
        <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Apply to theme
      </Button>
      <p className="text-xs text-muted-foreground">Applying updates the draft theme only. Review the live preview and contrast checks, then use Save at the top.</p>
    </div>
  );
}
