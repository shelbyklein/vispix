import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCollections,
  useReorderCollections,
  getListCollectionsQueryKey,
} from "@workspace/api-client-react";
import { useCardReorder } from "@/hooks/useCardReorder";
import { AppLayout } from "@/components/layout/AppLayout";
import { CrossfadeThumb } from "@/components/CrossfadeThumb";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkles } from "lucide-react";

export default function SmartCollections() {
  const qc = useQueryClient();
  const { data: collections, isLoading } = useListCollections();

  const smartCollections = collections ?? [];

  // Shares the collections sort order — this page and Collections render the
  // same rows, so dragging here rearranges both.
  const reorderMutation = useReorderCollections();
  const reorder = useCardReorder({
    ids: smartCollections.map((c) => c.id),
    onCommit: (orderedIds) =>
      reorderMutation.mutate(
        { data: { ids: orderedIds } },
        { onSuccess: () => qc.invalidateQueries({ queryKey: getListCollectionsQueryKey() }) },
      ),
  });

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="smart-collections-page">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-warning-foreground shrink-0" />
          <h1 className="text-2xl font-bold text-foreground">Smart Collections</h1>
        </div>
        <p className="text-sm text-muted-foreground -mt-3">
          Browse each collection by visual similarity — photos are ranked by how closely they match
          the collection's search term.
        </p>

        {isLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[4/3] rounded-xl" />
            ))}
          </div>
        ) : smartCollections.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center border-2 border-dashed border-border rounded-xl">
            <Sparkles className="h-10 w-10 text-muted-foreground/30 mb-3" />
            <p className="text-sm font-medium text-foreground mb-1">No smart collections yet</p>
            <p className="text-xs text-muted-foreground max-w-sm">
              Create a collection and open it here to browse matching photos by visual similarity.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4" data-testid="smart-collections-list">
            {reorder.arrange(smartCollections, (c) => c.id).map((col) => (
              <Link key={col.id} href={`/smart-collections/${col.id}`} {...reorder.handlers(col.id)}>
                <div
                  className={`relative rounded-xl overflow-hidden border border-border bg-card group cursor-pointer hover:shadow-md hover:border-warning/50 transition-all${reorder.draggingId === col.id ? " opacity-50" : ""}`}
                  data-testid={`smart-collection-card-${col.id}`}
                >
                  <CrossfadeThumb
                    urls={col.sampleThumbnailUrls ?? []}
                    alt={col.title}
                    className="aspect-[4/3] w-full"
                  />
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/35 to-transparent pt-8 pb-2.5 px-3 pointer-events-none">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-white drop-shadow">
                      <Sparkles className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                      <span className="truncate">{col.title}</span>
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
