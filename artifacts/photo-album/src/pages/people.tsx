import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCollections,
  useCreateCollection,
  useReorderCollections,
  getListCollectionsQueryKey,
} from "@workspace/api-client-react";
import { useCardReorder } from "@/hooks/useCardReorder";
import { AppLayout } from "@/components/layout/AppLayout";
import { CrossfadeThumb } from "@/components/CrossfadeThumb";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Users, Plus } from "lucide-react";

// People are collections with kind='person': same membership + similarity
// machinery, listed here instead of the Collections pages.
const PEOPLE_LIST_PARAMS = { kind: "person" as const };

function CreatePersonDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const { toast } = useToast();
  const { mutate: createCollection, isPending } = useCreateCollection();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    createCollection(
      { data: { title: name.trim(), description: description.trim() || undefined, kind: "person" } },
      {
        onSuccess: () => {
          toast({ title: `Added ${name.trim()}` });
          setName("");
          setDescription("");
          setOpen(false);
          onCreated();
        },
        onError: () => toast({ title: "Failed to add person", variant: "destructive" }),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2" size="sm" data-testid="add-person-btn">
          <Plus className="h-4 w-4" />
          Add Person
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Person</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="person-name">Name</Label>
            <Input
              id="person-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Casey Kaufhold"
              data-testid="person-name-input"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="person-description">Notes (optional)</Label>
            <Textarea
              id="person-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Team, division, anything that helps identify them"
              rows={2}
            />
          </div>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || !name.trim()} data-testid="create-person-submit">
              {isPending ? "Adding..." : "Add Person"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function People() {
  const qc = useQueryClient();
  const { data: people, isLoading } = useListCollections(PEOPLE_LIST_PARAMS);

  function refetch() {
    qc.invalidateQueries({ queryKey: getListCollectionsQueryKey(PEOPLE_LIST_PARAMS) });
  }

  const list = people ?? [];
  const reorderMutation = useReorderCollections();
  const reorder = useCardReorder({
    ids: list.map((p) => p.id),
    onCommit: (orderedIds) =>
      reorderMutation.mutate({ data: { ids: orderedIds } }, { onSuccess: refetch }),
  });

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="people-page">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary shrink-0" />
              <h1 className="text-2xl font-bold text-foreground">People</h1>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Tag a few photos to a person and their page will surface more photos of them by visual
              similarity.
            </p>
          </div>
          <CreatePersonDialog onCreated={refetch} />
        </div>

        {isLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[4/3] rounded-xl" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center border-2 border-dashed border-border rounded-xl">
            <Users className="h-10 w-10 text-muted-foreground/30 mb-3" />
            <p className="text-sm font-medium text-foreground mb-1">No people yet</p>
            <p className="text-xs text-muted-foreground max-w-sm">
              Add a person, then tag a few of their photos — the similarity ranking finds the rest.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4" data-testid="people-list">
            {reorder.arrange(list, (p) => p.id).map((person) => (
              <Link key={person.id} href={`/people/${person.id}`} {...reorder.handlers(person.id)}>
                <div
                  className={`relative rounded-xl overflow-hidden border border-border bg-card group cursor-pointer hover:shadow-md hover:border-primary/50 transition-all${reorder.draggingId === person.id ? " opacity-50" : ""}`}
                  data-testid={`person-card-${person.id}`}
                >
                  <CrossfadeThumb
                    urls={person.sampleThumbnailUrls ?? []}
                    alt={person.title}
                    className="aspect-[4/3] w-full"
                  />
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/35 to-transparent pt-8 pb-2.5 px-3 pointer-events-none">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-white drop-shadow">
                      <Users className="h-3.5 w-3.5 text-primary shrink-0" />
                      <span className="truncate">{person.title}</span>
                    </span>
                    <span className="text-xs text-white/75 drop-shadow">
                      {person.photoCount} photo{person.photoCount !== 1 ? "s" : ""}
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
