import type { Dispatch, SetStateAction } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DuplicateFile } from "./types";

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface DuplicateCheckPhaseProps {
  duplicates: DuplicateFile[];
  setDuplicates: Dispatch<SetStateAction<DuplicateFile[]>>;
  onBack: () => void;
  onContinue: () => void;
}

export function DuplicateCheckPhase({
  duplicates,
  setDuplicates,
  onBack,
  onContinue,
}: DuplicateCheckPhaseProps) {
  return (
    <AppLayout>
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <div>
            <h1 className="text-xl font-bold text-foreground">Duplicate Files Detected</h1>
            <p className="text-sm text-muted-foreground">
              {duplicates.length} file{duplicates.length !== 1 ? "s" : ""} already exist in the target album.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card divide-y divide-border">
          <div className="px-4 py-3 flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">File</span>
            <div className="flex items-center gap-4">
              <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setDuplicates((prev) => prev.map((d) => ({ ...d, skip: true })))}>Skip all</button>
              <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setDuplicates((prev) => prev.map((d) => ({ ...d, skip: false })))}>Overwrite all</button>
            </div>
          </div>
          {duplicates.map((dup, i) => (
            <div key={i} className="px-4 py-3 flex items-center gap-3">
              <Checkbox
                checked={dup.skip}
                onCheckedChange={(checked) =>
                  setDuplicates((prev) => prev.map((d, j) => (j === i ? { ...d, skip: !!checked } : d)))
                }
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground truncate">{dup.name}</p>
                <p className="text-xs text-muted-foreground">{humanSize(dup.size)}</p>
              </div>
              <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", dup.skip ? "bg-muted text-muted-foreground" : "bg-warning/15 text-warning")}>
                {dup.skip ? "Skip" : "Overwrite"}
              </span>
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={onBack}>Cancel</Button>
          <Button onClick={onContinue}>Continue Upload</Button>
        </div>
      </div>
    </AppLayout>
  );
}
