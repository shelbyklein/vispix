import { useMemo, useState } from "react";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { usePastGenerations, generationDownloadUrl, type PastGeneration } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { History, Loader2, Info, Download, Wand2, Megaphone, ImageOff } from "lucide-react";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { formatDate } from "@/lib/format-date";

// Past generations (#194): every image the org has generated, from Create
// sessions and campaign suggestions. Read-only, and deliberately outside the AI
// pipeline — these are not photos, so they are never analysed or searchable.

function summarize(prompt: string, max = 90): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function sourceLabel(g: PastGeneration): string {
  return g.source.type === "campaign" && g.source.campaignName
    ? `Campaign: ${g.source.campaignName}`
    : `Create: ${g.source.sessionTitle}`;
}

function SourceLink({ g }: { g: PastGeneration }) {
  if (g.source.type === "campaign" && g.source.campaignId != null) {
    return (
      <Link href={`/campaigns/${g.source.campaignId}`} className="inline-flex items-center gap-1 text-primary hover:underline">
        <Megaphone className="h-3.5 w-3.5" /> {sourceLabel(g)}
      </Link>
    );
  }
  return (
    <Link href={`/create?session=${g.source.sessionId}`} className="inline-flex items-center gap-1 text-primary hover:underline">
      <Wand2 className="h-3.5 w-3.5" /> {sourceLabel(g)}
    </Link>
  );
}

function GenerationDetail({ g, onClose }: { g: PastGeneration | null; onClose: () => void }) {
  return (
    <Dialog open={g != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto" data-testid="generation-detail">
        {g && (
          <>
            <DialogHeader>
              <DialogTitle>Generated image</DialogTitle>
              <DialogDescription>
                {formatDate(g.createdAt)}
                {g.creator ? ` by ${g.creator.name}` : ""}
                {g.width && g.height ? ` · ${g.width}×${g.height}` : ""}
                {g.format ? ` · ${g.format}` : ""}
              </DialogDescription>
            </DialogHeader>
            {g.imageUrl ? (
              <img src={g.imageUrl} alt={summarize(g.prompt, 200)} className="mx-auto max-h-[55vh] rounded-md object-contain" />
            ) : (
              <p className="text-sm text-muted-foreground">This generation did not produce an image.</p>
            )}
            <p className="whitespace-pre-wrap text-sm text-foreground">{g.prompt}</p>
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <SourceLink g={g} />
              {g.imageUrl && (
                <div className="flex gap-2">
                  <a href={generationDownloadUrl(g.id, "png")} download>
                    <Button size="sm" variant="outline" className="gap-1">
                      <Download className="h-3.5 w-3.5" /> PNG
                    </Button>
                  </a>
                  <a href={generationDownloadUrl(g.id, "jpg")} download>
                    <Button size="sm" variant="outline" className="gap-1">
                      <Download className="h-3.5 w-3.5" /> JPG
                    </Button>
                  </a>
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function GenerationsPage() {
  const [includeFailed, setIncludeFailed] = useState(false);
  const [selected, setSelected] = useState<PastGeneration | null>(null);
  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = usePastGenerations({
    includeFailed,
  });
  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);

  const sentinelRef = useInfiniteScroll(() => {
    if (!isFetchingNextPage) void fetchNextPage();
  }, !!hasNextPage);

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="generations-page">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
              <History className="h-6 w-6 text-primary" /> Past generations
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Every image generated in Create and in campaigns, newest first.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={includeFailed}
              onCheckedChange={(v) => setIncludeFailed(v === true)}
              data-testid="include-failed-toggle"
            />
            Show failed attempts
          </label>
        </div>

        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground" role="note">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Generated images are kept separate from your photo library. They are not analysed by AI, not embedded, and
            do not appear in search, the photo graph or smart collections.
          </p>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading generations…
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border py-16 text-center" role="alert">
            <p className="text-sm text-muted-foreground">Could not load past generations.</p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-16 text-center text-muted-foreground">
            <Wand2 className="h-8 w-8" />
            <p className="max-w-md text-sm">
              Nothing generated yet. Images you create in <Link href="/create" className="text-primary hover:underline">Create</Link> or
              from a <Link href="/campaigns" className="text-primary hover:underline">campaign</Link> will collect here.
            </p>
          </div>
        ) : (
          <>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" data-testid="generations-grid">
              {items.map((g) => (
                <li key={g.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(g)}
                    aria-label={`View generated image: ${summarize(g.prompt, 80)}`}
                    className="group relative block aspect-square w-full overflow-hidden rounded-lg border border-border bg-muted text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    data-testid={`generation-tile-${g.id}`}
                  >
                    {g.imageUrl ? (
                      <img
                        src={g.imageUrl}
                        alt={summarize(g.prompt, 200)}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-xs text-muted-foreground">
                        <ImageOff className="h-6 w-6" /> Failed
                      </span>
                    )}
                    <span className="absolute inset-x-0 bottom-0 flex flex-col gap-0.5 bg-gradient-to-t from-black/80 to-transparent p-2 pt-8 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                      <span className="line-clamp-2">{summarize(g.prompt)}</span>
                      <span className="truncate text-white/80">
                        {sourceLabel(g)} · {formatDate(g.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {hasNextPage && (
              <div ref={sentinelRef} className="flex justify-center py-4">
                <Button
                  variant="outline"
                  onClick={() => void fetchNextPage()}
                  disabled={isFetchingNextPage}
                  data-testid="load-more-generations"
                >
                  {isFetchingNextPage ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      <GenerationDetail g={selected} onClose={() => setSelected(null)} />
    </AppLayout>
  );
}
