import { useEffect, useState } from "react";
import { hexToHslString, hslStringToHex, parseHsl, formatHsl } from "./color-utils";

/** One token: native color picker + editable "H S% L%" text. */
export function ColorTokenRow({
  tokenKey,
  label,
  value,
  onChange,
}: {
  tokenKey: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const valid = parseHsl(text) !== null;

  return (
    <div className="flex items-center gap-2" data-testid={`token-${tokenKey}`}>
      <input
        type="color"
        aria-label={`${label} color`}
        value={hslStringToHex(value)}
        onChange={(e) => onChange(hexToHslString(e.target.value))}
        className="h-8 w-9 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-foreground">{label}</div>
        <div className="truncate font-mono text-[10px] text-muted-foreground">--{tokenKey}</div>
      </div>
      <input
        type="text"
        aria-label={`${label} HSL`}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = parseHsl(e.target.value.trim());
          if (parsed) onChange(formatHsl(parsed));
        }}
        onBlur={() => setText(value)}
        className={`h-8 w-40 rounded-md border bg-background px-2 font-mono text-xs ${
          valid ? "border-input" : "border-destructive"
        }`}
      />
    </div>
  );
}
