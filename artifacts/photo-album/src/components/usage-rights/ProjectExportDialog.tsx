import { useState } from "react";
import { useGetProjectRightsCheck, getGetProjectRightsCheckQueryKey } from "@workspace/api-client-react";
import { AlertTriangle, Check, Download, Loader2, RotateCw, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// Project export confirmation (#207). Re-checks every photo's usage rights at
// the moment of download and says what's unknown or changed since it was
// shortlisted. Warning-only: download is always allowed, and the zip carries
// the same check as usage-rights.json.
export function ProjectExportButton({ projectId, projectName, photoCount }: { projectId: number; projectName: string; photoCount: number }) {
  const [open, setOpen] = useState(false);
  const check = useGetProjectRightsCheck(projectId, {
    query: { enabled: open, queryKey: getGetProjectRightsCheckQueryKey(projectId), staleTime: 0, refetchOnMount: "always" },
  });
  const data = check.data;
  const flagged = data?.photos.filter((p) => p.usageRights.status === "not_recorded" || p.changedSinceShortlist) ?? [];
  const needsCare = (data?.counts.notRecorded ?? 0) > 0 || (data?.counts.changedSinceShortlist ?? 0) > 0;

  return (
    <>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)} data-testid="bulk-download-btn">
        <Download className="h-4 w-4" />
        <span className="hidden sm:inline">Bulk download</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg" data-testid="export-rights-dialog">
          <DialogHeader>
            <DialogTitle>
              Download “{projectName}” ({photoCount} photo{photoCount === 1 ? "" : "s"})
            </DialogTitle>
            <DialogDescription>Usage rights checked just now. Recorded rights are your team’s records, not a legal clearance.</DialogDescription>
          </DialogHeader>

          {check.isLoading && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking usage rights…
            </p>
          )}
          {check.isError && (
            <div className="flex items-center gap-2 text-sm" role="alert" data-testid="export-rights-error">
              Couldn’t check usage rights.
              <Button variant="ghost" size="sm" className="h-7 gap-1" onClick={() => void check.refetch()}>
                <RotateCw className="h-3.5 w-3.5" /> Retry
              </Button>
            </div>
          )}
          {data && (
            <div className="space-y-3" data-testid="export-rights-summary">
              <ul className="space-y-1 text-sm" role="status">
                <li className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                  <Check className="h-4 w-4" aria-hidden /> {data.counts.recorded} with recorded rights
                </li>
                <li className={data.counts.notRecorded > 0 ? "flex items-center gap-1.5 text-amber-700 dark:text-amber-300" : "flex items-center gap-1.5 text-muted-foreground"}>
                  <AlertTriangle className="h-4 w-4" aria-hidden /> {data.counts.notRecorded} with rights not recorded
                </li>
                <li className={data.counts.changedSinceShortlist > 0 ? "flex items-center gap-1.5 text-red-600 dark:text-red-300" : "flex items-center gap-1.5 text-muted-foreground"}>
                  <History className="h-4 w-4" aria-hidden /> {data.counts.changedSinceShortlist} changed since shortlisted
                </li>
              </ul>
              {flagged.length > 0 && (
                <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-xs" data-testid="export-rights-flagged">
                  {flagged.map((p) => (
                    <li key={p.photoId} className="flex flex-wrap gap-x-1.5">
                      <span className="font-medium">{p.filename ?? `Photo ${p.photoId}`}</span>
                      <span className="text-muted-foreground">
                        —{" "}
                        {[
                          p.usageRights.status === "not_recorded" ? "rights not recorded" : null,
                          p.changedSinceShortlist && p.changedSinceShortlist.removed.length > 0
                            ? `${p.changedSinceShortlist.removed.map((t) => `“${t.name}”`).join(", ")} removed`
                            : null,
                          p.changedSinceShortlist && p.changedSinceShortlist.added.length > 0
                            ? `${p.changedSinceShortlist.added.map((t) => `“${t.name}”`).join(", ")} added`
                            : null,
                        ]
                          .filter(Boolean)
                          .join("; ")}
                        {p.changedSinceShortlist ? " since shortlisted" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {data.counts.notCapturedAtShortlist > 0 && (
                <p className="text-xs text-muted-foreground">
                  {data.counts.notCapturedAtShortlist} photo{data.counts.notCapturedAtShortlist === 1 ? " was" : "s were"} shortlisted before rights were tracked, so changes can’t be compared.
                </p>
              )}
              <p className="text-xs text-muted-foreground">The zip includes usage-rights.json with this check.</p>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button asChild disabled={!data} data-testid="export-download-confirm">
              {/* Plain link: the browser streams the zip with its own progress. */}
              <a href={`/api/projects/${projectId}/download`} onClick={() => setOpen(false)}>
                <Download className="h-4 w-4" />
                {needsCare ? "Download anyway" : "Download"}
              </a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
