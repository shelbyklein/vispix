import { useState } from "react";
import {
  useListAttributionTags,
  getListAttributionTagsQueryKey,
  useCreateAttributionTag,
  useUpdateAttributionTag,
  useDeleteAttributionTag,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AdminSectionShell } from "@/components/admin/AdminSectionShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Copyright, Loader2, Plus, Pencil, Trash2, Check, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function AdminAttributionTagsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: tags, isLoading } = useListAttributionTags();
  const { mutate: createTag, isPending: creating } = useCreateAttributionTag();
  const { mutate: updateTag, isPending: renaming } = useUpdateAttributionTag();
  const { mutate: deleteTag, isPending: deleting } = useDeleteAttributionTag();

  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");

  function refresh() {
    qc.invalidateQueries({ queryKey: getListAttributionTagsQueryKey() });
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    createTag(
      { data: { name } },
      {
        onSuccess: () => {
          setNewName("");
          refresh();
          toast({ title: `Tag "${name}" created` });
        },
        onError: () => toast({ title: "Failed to create tag (duplicate name?)", variant: "destructive" }),
      },
    );
  }

  function handleRename(id: number) {
    const name = editName.trim();
    if (!name) return;
    updateTag(
      { id, data: { name } },
      {
        onSuccess: () => {
          setEditingId(null);
          refresh();
          toast({ title: "Tag renamed" });
        },
        onError: () => toast({ title: "Failed to rename tag", variant: "destructive" }),
      },
    );
  }

  function handleDelete(id: number, name: string) {
    deleteTag(
      { id },
      {
        onSuccess: () => {
          refresh();
          toast({ title: `Tag "${name}" deleted` });
        },
        onError: () => toast({ title: "Failed to delete tag", variant: "destructive" }),
      },
    );
  }

  return (
    <AdminSectionShell
      title="Attribution Tags"
      icon={Copyright}
      description="User-defined usage-rights tags (e.g. Web, Print, Social). A tag records that your team allows that kind of use. It is your own record, not a legal clearance; photos without a tag show as “rights not recorded”."
    >
      <div className="rounded-xl border border-border bg-card overflow-hidden max-w-2xl">
        <div className="px-5 py-4 border-b border-border">
          <form onSubmit={handleCreate} className="flex gap-2" data-testid="create-attribution-tag-form">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New tag name (e.g. Social)…"
              className="h-9 flex-1"
              disabled={creating}
              data-testid="new-attribution-tag-input"
            />
            <Button type="submit" size="sm" className="h-9 gap-1.5" disabled={creating || !newName.trim()} data-testid="create-attribution-tag-btn">
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add tag
            </Button>
          </form>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-1.5 px-5 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading tags…
          </div>
        ) : !tags || tags.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">No attribution tags yet — add the first one above.</p>
        ) : (
          <div className="divide-y divide-border" data-testid="attribution-tags-list">
            {tags.map((tag) => (
              <div key={tag.id} className="flex items-center gap-2 px-5 py-3" data-testid={`attribution-tag-row-${tag.id}`}>
                {editingId === tag.id ? (
                  <>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="h-8 flex-1"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); handleRename(tag.id); }
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      data-testid={`edit-attribution-tag-input-${tag.id}`}
                    />
                    <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={() => handleRename(tag.id)} disabled={renaming || !editName.trim()} aria-label="Save name" data-testid={`save-attribution-tag-${tag.id}`}>
                      <Check className="h-4 w-4" />
                    </Button>
                    <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditingId(null)} aria-label="Cancel rename">
                      <X className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-sm font-medium text-foreground">{tag.name}</span>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => { setEditingId(tag.id); setEditName(tag.name); }}
                      aria-label={`Rename ${tag.name}`}
                      data-testid={`rename-attribution-tag-${tag.id}`}
                    >
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button type="button" size="icon" variant="ghost" className="h-8 w-8" disabled={deleting} aria-label={`Delete ${tag.name}`} data-testid={`delete-attribution-tag-${tag.id}`}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete "{tag.name}"?</AlertDialogTitle>
                          <AlertDialogDescription>
                            The tag is removed from every photo that carries it. This cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleDelete(tag.id, tag.name)}
                            className="bg-destructive hover:bg-destructive/90"
                            data-testid={`confirm-delete-attribution-tag-${tag.id}`}
                          >
                            Delete tag
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </AdminSectionShell>
  );
}
