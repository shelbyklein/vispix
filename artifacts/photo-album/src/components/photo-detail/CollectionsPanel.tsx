import type { CollectionSummary, Collection, Project } from "@workspace/api-client-react";
import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FolderOpen, FolderKanban, Loader2, Plus, Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function CollectionsPanel({
  photoCollections,
  availableCollections,
  projects,
  newCollectionName,
  setNewCollectionName,
  creatingCollection,
  onAddCollection,
  onRemoveFromCollection,
  onCreateNewCollection,
  onAddProject,
}: {
  photoCollections?: CollectionSummary[];
  availableCollections?: Collection[];
  projects?: Project[];
  newCollectionName: string;
  setNewCollectionName: (value: string) => void;
  creatingCollection: boolean;
  onAddCollection: (collectionId: string) => void;
  onRemoveFromCollection: (collectionId: number) => void;
  onCreateNewCollection: (e: React.FormEvent) => void;
  onAddProject: (projectId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);

  // One toggle-pill cloud, mirroring the lightbox sidebar: members first (click
  // removes), then the rest (click adds). AI recommendations are NOT marked here:
  // they come from the server and render in the AI panel (#212). Collapsed view
  // shows the top 5 (always including all members) behind a "+N more" toggle.
  const members = photoCollections ?? [];
  const nonMembers = availableCollections ?? [];
  const all = [
    ...members.map((c) => ({ id: c.id, title: c.title, isIn: true })),
    ...nonMembers.map((c) => ({ id: c.id, title: c.title, isIn: false })),
  ];
  const visibleCount = Math.max(5, members.length);
  const hiddenCount = all.length - visibleCount;
  const shown = showAll || hiddenCount <= 0 ? all : all.slice(0, visibleCount);

  return (
    <>
      <div className="space-y-2">
        <Label className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
          <FolderOpen className="h-3.5 w-3.5" />
          Collections
        </Label>
        {all.length > 0 ? (
          <div className="flex flex-wrap gap-1.5" data-testid="photo-collections">
            {shown.map((col) => {
              return (
                <button
                  key={col.id}
                  type="button"
                  onClick={() =>
                    col.isIn ? onRemoveFromCollection(col.id) : onAddCollection(String(col.id))
                  }
                  className={cn(
                    "flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors",
                    col.isIn
                      ? "bg-primary text-primary-foreground border-primary hover:bg-primary/85"
                      : "bg-transparent text-muted-foreground border-border hover:bg-muted hover:text-foreground"
                  )}
                  data-testid={`photo-collection-pill-${col.id}`}
                  aria-label={col.isIn ? `Remove from ${col.title}` : `Add to ${col.title}`}
                  aria-pressed={col.isIn}
                >
                  {col.isIn ? (
                    <Check className="h-3 w-3 shrink-0" />
                  ) : (
                    <Plus className="h-3 w-3 shrink-0" />
                  )}
                  {col.title}
                </button>
              );
            })}
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border border-dashed border-border text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                data-testid="photo-collections-toggle"
                aria-expanded={showAll}
              >
                {showAll ? "Show less" : `+${hiddenCount} more`}
              </button>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No collections yet.</p>
        )}
        <form
          onSubmit={onCreateNewCollection}
          className="flex gap-1.5"
          data-testid="create-collection-form"
        >
          <Input
            value={newCollectionName}
            onChange={(e) => setNewCollectionName(e.target.value)}
            placeholder="New collection name..."
            className="h-8 text-sm flex-1"
            disabled={creatingCollection}
            data-testid="new-collection-name-input"
          />
          <Button
            type="submit"
            size="sm"
            className="h-8 px-2.5 gap-1"
            disabled={creatingCollection || !newCollectionName.trim()}
            data-testid="create-collection-submit"
          >
            {creatingCollection ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Create
          </Button>
        </form>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
          <FolderKanban className="h-3.5 w-3.5" />
          Projects
        </Label>
        {projects && projects.length > 0 ? (
          <Select onValueChange={onAddProject} data-testid="add-project-select">
            <SelectTrigger className="h-8 text-sm w-full">
              <SelectValue placeholder="Add to project..." />
            </SelectTrigger>
            <SelectContent>
              {projects.map((proj) => (
                <SelectItem key={proj.id} value={String(proj.id)} data-testid={`project-option-${proj.id}`}>
                  {proj.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="text-xs text-muted-foreground">
            No projects yet.{" "}
            <Link href="/projects" className="text-primary hover:underline">
              Create one
            </Link>
            .
          </p>
        )}
      </div>
    </>
  );
}
