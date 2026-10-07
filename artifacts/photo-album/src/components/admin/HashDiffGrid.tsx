import { cn } from "@/lib/utils";

// Visualize how two photos' perceptual hashes differ (issue #129). A dHash is
// 64 bits (16 hex chars) laid out as an 8x8 grid of brightness-gradient bits;
// the Hamming distance between two hashes is exactly the near-duplicate
// "distance". We render both grids plus a diff grid where differing bits light
// up amber — making "6 bits apart" literally visible.

export function hexToBits(hash: string): boolean[] | null {
  if (!/^[0-9a-f]{16}$/i.test(hash)) return null;
  const bits: boolean[] = [];
  for (const ch of hash) {
    const n = parseInt(ch, 16);
    bits.push(!!(n & 8), !!(n & 4), !!(n & 2), !!(n & 1));
  }
  return bits;
}

export function hammingDistance(a: string, b: string): number | null {
  const ba = hexToBits(a);
  const bb = hexToBits(b);
  if (!ba || !bb) return null;
  let d = 0;
  for (let i = 0; i < 64; i++) if (ba[i] !== bb[i]) d++;
  return d;
}

function BitGrid({ bits, diff, label }: { bits: boolean[]; diff?: boolean[]; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="grid grid-cols-8 gap-px rounded-sm overflow-hidden border border-border" style={{ width: "fit-content" }}>
        {bits.map((bit, i) => (
          <div
            key={i}
            className={cn(
              "h-2.5 w-2.5",
              diff?.[i]
                ? "bg-warning" // differing bit
                : bit
                  ? "bg-foreground/80"
                  : "bg-muted",
            )}
          />
        ))}
      </div>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}

export function HashDiffGrid({ hashA, hashB }: { hashA: string; hashB: string }) {
  const bitsA = hexToBits(hashA);
  const bitsB = hexToBits(hashB);
  if (!bitsA || !bitsB) return null;
  const diff = bitsA.map((b, i) => b !== bitsB[i]);

  return (
    <div className="flex items-start justify-center gap-4" data-testid="hash-diff-grid">
      <BitGrid bits={bitsA} label="A" />
      <BitGrid bits={bitsB} label="B" />
      <BitGrid bits={diff} diff={diff} label="difference" />
    </div>
  );
}
