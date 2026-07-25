import type { PhotoAiEvaluation } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Gauge } from "lucide-react";
import { cn } from "@/lib/utils";

const CRITERIA: { key: keyof PhotoAiEvaluation; label: string }[] = [
  { key: "technicalQuality", label: "Technical quality" },
  { key: "composition", label: "Composition" },
  { key: "subjectClarity", label: "Subject clarity" },
  { key: "emotionalImpact", label: "Emotional impact" },
  { key: "marketingUsability", label: "Marketing usability" },
];

function scoreTone(score: number): string {
  if (score >= 7) return "text-emerald-700 dark:text-emerald-400";
  if (score >= 5) return "text-foreground";
  return "text-amber-700 dark:text-amber-400";
}

function barTone(score: number): string {
  if (score >= 7) return "bg-emerald-500";
  if (score >= 5) return "bg-primary";
  return "bg-amber-500";
}

// AI criteria evaluation card (#181): overall score, per-criterion bars, and
// flaw chips. Shown on the photo detail page whenever the photo has been scored.
export function AiEvaluationPanel({ evaluation }: { evaluation: PhotoAiEvaluation }) {
  return (
    <div
      className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 space-y-2"
      data-testid="ai-evaluation-block"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Gauge className="h-3.5 w-3.5" />
          AI evaluation
        </div>
        <span
          className={cn("text-sm font-semibold", scoreTone(evaluation.overallScore))}
          title="Weighted overall score across the criteria below"
          data-testid="ai-evaluation-overall"
        >
          {evaluation.overallScore.toFixed(1)}/10
        </span>
      </div>
      <div className="space-y-1.5">
        {CRITERIA.map(({ key, label }) => {
          const value = Number(evaluation[key] ?? 0);
          return (
            <div key={key} className="flex items-center gap-2" data-testid={`ai-eval-${key}`}>
              <span className="w-36 shrink-0 text-[11px] text-muted-foreground">{label}</span>
              <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
                <div
                  className={cn("h-full rounded-full", barTone(value))}
                  style={{ width: `${(value / 10) * 100}%` }}
                />
              </div>
              <span className="w-6 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {value}
              </span>
            </div>
          );
        })}
      </div>
      {evaluation.flaws.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5" data-testid="ai-eval-flaws">
          {evaluation.flaws.map((flaw) => (
            <Badge
              key={flaw}
              variant="outline"
              className="text-[10px] border-amber-500/50 text-amber-700 dark:text-amber-400"
            >
              {flaw}
            </Badge>
          ))}
        </div>
      )}
      {evaluation.orientationSuitability && (
        <p className="text-[11px] text-muted-foreground">
          Suits: {evaluation.orientationSuitability}
        </p>
      )}
    </div>
  );
}
