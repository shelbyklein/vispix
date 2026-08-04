import { useEffect, useRef, useState } from "react";
import {
  useListAssets,
  useCreateAsset,
  useUpdateAsset,
  useDeleteAsset,
  useListProjects,
  getListAssetsQueryKey,
  type Asset,
  type AssetKind,
} from "@workspace/api-client-react";
import { useUpload, isAllowedUploadType } from "@workspace/object-storage-web";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Palette, Download, Pencil, Trash2, Upload, FileImage, Folder, FolderPlus, Loader2, Check, X } from "lucide-react";
import { useLocation, useSearch } from "wouter";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { collectFolders, FolderCard, FolderBreadcrumb } from "@/components/FolderBrowser";

// The asset library holds non-photo files pulled into deliverables: brand
// assets (logos/marks to embed) and reference works (past output to match).
// Both the web UI and the MCP tools (list_assets / get_asset) read it.

const KIND_LABEL: Record<AssetKind, string> = { brand: "Brand", reference: "Reference" };

// Sentinel for "no project" in Selects — Radix Select can't use "" as a value.
const GLOBAL = "__global__";

type AssetFields = {
  kind: AssetKind;
  name: string;
  variant: string;
  notes: string;
  folder: string;
  projectId: string; // Select value: GLOBAL or a project id as string
};

function AssetFieldInputs({
  fields,
  setFields,
  idPrefix,
  hideNameVariant = false,
}: {
  fields: AssetFields;
  setFields: (f: AssetFields) => void;
  idPrefix: string;
  // The bulk upload dialog collects name/variant per file, so it only wants
  // the shared fields (kind/project/folder/notes) from this form.
  hideNameVariant?: boolean;
}) {
  const { data: projects } = useListProjects();
  const { data: allAssets } = useListAssets();
  const folderSuggestions = collectFolders(allAssets);
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-kind`}>Kind</Label>
          <Select value={fields.kind} onValueChange={(v) => setFields({ ...fields, kind: v as AssetKind })}>
            <SelectTrigger id={`${idPrefix}-kind`} data-testid={`${idPrefix}-kind`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="brand">Brand asset (logo / mark)</SelectItem>
              <SelectItem value="reference">Reference (past work)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-project`}>Project</Label>
          <Select value={fields.projectId} onValueChange={(v) => setFields({ ...fields, projectId: v })}>
            <SelectTrigger id={`${idPrefix}-project`} data-testid={`${idPrefix}-project`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={GLOBAL}>Global (all projects)</SelectItem>
              {(projects ?? []).map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {!hideNameVariant && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-name`}>Name *</Label>
            <Input
              id={`${idPrefix}-name`}
              value={fields.name}
              onChange={(e) => setFields({ ...fields, name: e.target.value })}
              placeholder="Primary logo"
              required
              data-testid={`${idPrefix}-name`}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-variant`}>Variant</Label>
            <Input
              id={`${idPrefix}-variant`}
              value={fields.variant}
              onChange={(e) => setFields({ ...fields, variant: e.target.value })}
              placeholder={fields.kind === "brand" ? "primary / white / icon-only" : "poster / social / program"}
              data-testid={`${idPrefix}-variant`}
            />
          </div>
        </>
      )}
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-folder`}>Folder</Label>
        <Input
          id={`${idPrefix}-folder`}
          value={fields.folder}
          onChange={(e) => setFields({ ...fields, folder: e.target.value })}
          placeholder='Optional — e.g. "Logos" or "2026"'
          list={`${idPrefix}-folder-options`}
          data-testid={`${idPrefix}-folder`}
        />
        <datalist id={`${idPrefix}-folder-options`}>
          {folderSuggestions.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-notes`}>Usage notes</Label>
        <Textarea
          id={`${idPrefix}-notes`}
          value={fields.notes}
          onChange={(e) => setFields({ ...fields, notes: e.target.value })}
          placeholder="When to use this file, clear-space rules, etc."
          rows={2}
          data-testid={`${idPrefix}-notes`}
        />
      </div>
    </>
  );
}

// Fonts are a valid asset now (#162) — detect by content type, falling back to
// the extension since browsers often send fonts as octet-stream.
function isFontAsset(a: { contentType: string; filename?: string | null; name: string }): boolean {
  const ct = a.contentType.toLowerCase();
  return (
    ct.startsWith("font/") ||
    /(woff|ttf|otf|sfnt|opentype|truetype)/.test(ct) ||
    /\.(ttf|otf|woff2?|eot)$/i.test(a.filename ?? a.name)
  );
}

// Live specimen for a font asset: @font-face-load the file and render sample
// glyphs in it. Falls back to the default face until it loads.
function FontPreview({ url, id }: { url: string; id: number }) {
  const family = `asset-font-${id}`;
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let face: FontFace | null = null;
    try {
      face = new FontFace(family, `url("${url}")`);
      face.load().then((f) => { document.fonts.add(f); setLoaded(true); }).catch(() => {});
    } catch {
      /* FontFace unsupported — leave the fallback face */
    }
    return () => { if (face) { try { document.fonts.delete(face); } catch { /* noop */ } } };
  }, [url, family]);
  const ff = loaded ? `"${family}"` : undefined;
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-3 text-center">
      <span style={{ fontFamily: ff }} className="text-3xl leading-none text-foreground">Ag</span>
      <span style={{ fontFamily: ff }} className="text-xs text-muted-foreground">The quick brown fox</span>
    </div>
  );
}

function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

// One row per picked file in the bulk upload dialog (#197). Name/variant are
// per-file; kind/project/folder/notes are shared across the batch.
type UploadItem = {
  file: File;
  name: string;
  variant: string;
  status: "pending" | "uploading" | "done" | "error";
  error?: string;
};

// How many files upload at once; the rest wait their turn.
const UPLOAD_CONCURRENCY = 3;

function UploadAssetDialog({ onSaved, testId = "upload-asset-btn" }: { onSaved: () => void; testId?: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [fields, setFields] = useState<AssetFields>({ kind: "brand", name: "", variant: "", notes: "", folder: "", projectId: GLOBAL });
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { uploadFile } = useUpload();
  const { mutateAsync: createAsset } = useCreateAsset();
  const { toast } = useToast();

  function reset() {
    setItems([]);
    setIsDragOver(false);
    setFields({ kind: "brand", name: "", variant: "", notes: "", folder: "", projectId: GLOBAL });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // Shared by the file picker and drag-and-drop.
  function addFiles(selected: File[]) {
    const accepted = selected.filter((f) => isAllowedUploadType(f.name, f.type || "application/octet-stream"));
    if (accepted.length < selected.length) {
      toast({
        title: `Skipped ${selected.length - accepted.length} unsupported file${selected.length - accepted.length !== 1 ? "s" : ""}`,
        description: "Assets can be images or fonts (TTF/OTF/WOFF).",
        variant: "destructive",
      });
    }
    if (accepted.length === 0) return;
    setItems((prev) => [
      ...prev,
      ...accepted.map((file) => ({ file, name: stripExtension(file.name), variant: "", status: "pending" as const })),
    ]);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(e.target.files ?? []));
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    addFiles(Array.from(e.dataTransfer.files ?? []));
  }

  function setItem(index: number, patch: Partial<UploadItem>) {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  }

  function removeItem(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  const remaining = items.filter((it) => it.status !== "done");
  const hasFailed = items.some((it) => it.status === "error");
  const canSubmit = !submitting && remaining.length > 0 && remaining.every((it) => it.name.trim());

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);

    // Snapshot of what to process — indexes into `items`, whose per-row inputs
    // are disabled while submitting so the snapshot can't go stale. Re-submitting
    // after a partial failure only retries the non-done rows.
    const queue = items.map((it, i) => (it.status === "done" ? -1 : i)).filter((i) => i >= 0);
    const total = queue.length;
    const snapshot = items;
    let created = 0;
    let failed = 0;

    async function worker() {
      for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
        const item = snapshot[i];
        setItem(i, { status: "uploading", error: undefined });
        const uploaded = await uploadFile(item.file);
        if (!uploaded) {
          setItem(i, { status: "error", error: "Upload failed" });
          failed++;
          continue;
        }
        try {
          await createAsset({
            data: {
              kind: fields.kind,
              name: item.name.trim(),
              variant: item.variant.trim() || undefined,
              notes: fields.notes.trim() || undefined,
              folder: fields.folder.trim() || undefined,
              projectId: fields.projectId === GLOBAL ? undefined : parseInt(fields.projectId, 10),
              storageKey: uploaded.objectPath,
              contentType: item.file.type || "application/octet-stream",
              filename: item.file.name,
              fileSize: item.file.size,
            },
          });
          setItem(i, { status: "done" });
          created++;
        } catch {
          setItem(i, { status: "error", error: "Failed to save asset" });
          failed++;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, total) }, worker));

    setSubmitting(false);
    if (created > 0) onSaved();
    if (failed === 0) {
      setOpen(false);
      reset();
      toast({
        title: created === 1 ? "Asset added" : `${created} assets added`,
        description: created === 1 ? undefined : "All files are in the library.",
      });
    } else {
      toast({
        title: `${failed} of ${total} file${total !== 1 ? "s" : ""} failed`,
        description: "Successful files were saved. Retry or remove the failed ones.",
        variant: "destructive",
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (submitting) return; setOpen(next); if (!next) reset(); }}>
      <DialogTrigger asChild>
        <Button className="gap-2" data-testid={testId}>
          <Plus className="h-4 w-4" />
          Add Assets
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Add Assets</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex-1 min-h-0 overflow-y-auto space-y-4 pt-2 pr-1">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            disabled={submitting}
            className={`w-full border-2 border-dashed rounded-lg py-5 flex flex-col items-center justify-center gap-1.5 transition-colors ${
              isDragOver
                ? "border-primary bg-primary/5 text-foreground"
                : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
            }`}
            data-testid="asset-drop-zone"
          >
            <Upload className="h-6 w-6" />
            <span className="text-sm font-medium">
              {isDragOver ? "Drop files here" : "Click to select or drag files here"}
            </span>
            <span className="text-xs">Multiple files supported · SVG, PNG, JPEG, or fonts (TTF/OTF/WOFF)</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
            multiple
            className="hidden"
            onChange={handleFileChange}
            data-testid="asset-file-input"
          />

          {items.length > 0 && (
            <div className="space-y-2">
              {items.map((item, index) => (
                <div key={index} className="rounded-lg bg-muted/40 p-2.5 space-y-1.5" data-testid={`asset-upload-row-${index}`}>
                  <div className="flex items-center gap-2">
                    <span className="flex-1 truncate text-xs text-muted-foreground">
                      {item.file.name} · {(item.file.size / 1024).toFixed(0)} KB
                    </span>
                    {item.status === "uploading" ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                    ) : item.status === "done" ? (
                      <Check className="h-4 w-4 shrink-0 text-green-600" />
                    ) : (
                      <button
                        type="button"
                        onClick={() => removeItem(index)}
                        disabled={submitting}
                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                        aria-label={`Remove ${item.file.name}`}
                        data-testid={`asset-upload-remove-${index}`}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  {item.status !== "done" && (
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        value={item.name}
                        onChange={(e) => setItem(index, { name: e.target.value })}
                        placeholder="Name *"
                        disabled={submitting}
                        className="h-8"
                        data-testid={`asset-upload-name-${index}`}
                      />
                      <Input
                        value={item.variant}
                        onChange={(e) => setItem(index, { variant: e.target.value })}
                        placeholder="Variant (optional)"
                        disabled={submitting}
                        className="h-8"
                      />
                    </div>
                  )}
                  {item.status === "error" && item.error && (
                    <p className="text-xs text-destructive">{item.error}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          <AssetFieldInputs fields={fields} setFields={setFields} idPrefix="asset-new" hideNameVariant />
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit} data-testid="asset-upload-submit">
              {submitting
                ? "Uploading…"
                : hasFailed
                  ? "Retry failed"
                  : remaining.length > 1
                    ? `Add ${remaining.length} to Library`
                    : "Add to Library"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Folder-first creation, ported from albums (#161 → #198): name a folder and
// pick which assets go in it, setting each asset's folder in one step. Implicit
// folders can't be empty, so ≥1 asset is required.
function NewAssetFolderDialog({
  assets,
  folderSuggestions,
  onCreated,
}: {
  assets: Asset[];
  folderSuggestions: string[];
  onCreated: (folder: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const { mutateAsync: updateAsset } = useUpdateAsset();
  const { toast } = useToast();

  function resetState() {
    setName("");
    setFilter("");
    setSelected(new Set());
  }

  const filtered = assets.filter((a) => a.name.toLowerCase().includes(filter.trim().toLowerCase()));

  function toggle(id: number) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const folder = name.trim();
    if (!folder || selected.size === 0 || saving) return;
    setSaving(true);
    let ok = 0;
    let fail = 0;
    for (const id of selected) {
      try {
        await updateAsset({ id, data: { folder } });
        ok++;
      } catch {
        fail++;
      }
    }
    setSaving(false);
    setOpen(false);
    resetState();
    if (fail > 0) {
      toast({
        title: `Added ${ok} asset${ok !== 1 ? "s" : ""}, ${fail} failed`,
        description: "Only an asset's creator or an admin can move it.",
        variant: "destructive",
      });
    } else {
      toast({ title: `Folder "${folder}" created`, description: `${ok} asset${ok !== 1 ? "s" : ""} added.` });
    }
    if (ok > 0) onCreated(folder);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) resetState(); }}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2" data-testid="new-asset-folder-btn">
          <FolderPlus className="h-4 w-4" />
          New Folder
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="new-asset-folder-name">Folder name</Label>
            <Input
              id="new-asset-folder-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='e.g. "Logos" or "2026"'
              list="new-asset-folder-options"
              autoFocus
              data-testid="new-asset-folder-name"
            />
            <datalist id="new-asset-folder-options">
              {folderSuggestions.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1.5">
            <Label>Assets in this folder</Label>
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter assets…"
              className="h-8"
              data-testid="new-asset-folder-filter"
            />
            <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
              {filtered.length === 0 ? (
                <p className="px-3 py-4 text-center text-sm text-muted-foreground">No assets</p>
              ) : (
                filtered.map((a) => (
                  <label key={a.id} className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-accent/50">
                    <Checkbox
                      checked={selected.has(a.id)}
                      onCheckedChange={() => toggle(a.id)}
                      data-testid={`new-asset-folder-asset-${a.id}`}
                    />
                    <span className="flex-1 truncate text-sm text-foreground">{a.name}</span>
                    {a.folder && <span className="text-xs text-muted-foreground">in {a.folder}</span>}
                  </label>
                ))
              )}
            </div>
            <p className="text-xs text-muted-foreground">{selected.size} selected</p>
          </div>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={saving || !name.trim() || selected.size === 0} data-testid="new-asset-folder-submit">
              {saving ? "Creating…" : "Create folder"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditAssetDialog({ asset, onSaved }: { asset: Asset; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<AssetFields>({
    kind: asset.kind,
    name: asset.name,
    variant: asset.variant ?? "",
    notes: asset.notes ?? "",
    folder: asset.folder ?? "",
    projectId: asset.projectId != null ? String(asset.projectId) : GLOBAL,
  });
  const { mutate: updateAsset, isPending } = useUpdateAsset();
  const { toast } = useToast();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!fields.name.trim()) return;
    updateAsset(
      {
        id: asset.id,
        data: {
          kind: fields.kind,
          name: fields.name.trim(),
          variant: fields.variant.trim() || null,
          notes: fields.notes.trim() || null,
          folder: fields.folder.trim() || null,
          projectId: fields.projectId === GLOBAL ? null : parseInt(fields.projectId, 10),
        },
      },
      {
        onSuccess: () => {
          setOpen(false);
          onSaved();
          toast({ title: "Asset updated" });
        },
        onError: () => toast({ title: "Failed to update asset", variant: "destructive" }),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Edit ${asset.name}`} data-testid={`edit-asset-${asset.id}`}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Asset</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <AssetFieldInputs fields={fields} setFields={setFields} idPrefix={`asset-edit-${asset.id}`} />
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || !fields.name.trim()} data-testid={`asset-edit-submit-${asset.id}`}>
              {isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AssetCard({ asset, onChanged, onMove }: { asset: Asset; onChanged: () => void; onMove: (asset: Asset) => void }) {
  const { mutate: deleteAsset, isPending: deleting } = useDeleteAsset();
  const { toast } = useToast();
  const fileUrl = `/api/storage${asset.storageKey}`;

  function handleDelete() {
    deleteAsset(
      { id: asset.id },
      {
        onSuccess: () => {
          onChanged();
          toast({ title: `Deleted "${asset.name}"` });
        },
        onError: () => toast({ title: "Failed to delete asset", variant: "destructive" }),
      },
    );
  }

  return (
    <div className="rounded-xl overflow-hidden border border-border bg-card group" data-testid={`asset-card-${asset.id}`}>
      {/* Logos are often transparent or white — checker background keeps them visible in both themes. */}
      <div className="aspect-[4/3] bg-muted flex items-center justify-center overflow-hidden [background-image:repeating-conic-gradient(hsl(var(--border))_0%_25%,transparent_0%_50%)] [background-size:16px_16px]">
        {asset.contentType.startsWith("image/") ? (
          <img src={fileUrl} alt={asset.name} className="max-h-full max-w-full object-contain p-4" loading="lazy" />
        ) : isFontAsset(asset) ? (
          <FontPreview url={fileUrl} id={asset.id} />
        ) : (
          <FileImage className="h-10 w-10 text-muted-foreground/40" />
        )}
      </div>
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium text-foreground text-sm truncate">{asset.name}</p>
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {asset.projectName ?? "Global"}
              {asset.variant ? ` · ${asset.variant}` : ""}
            </p>
          </div>
          <Badge
            variant="secondary"
            className={cn(
              "shrink-0",
              asset.kind === "brand" ? "bg-primary/10 text-primary" : "bg-amber-500/10 text-amber-600 dark:text-amber-500",
            )}
          >
            {KIND_LABEL[asset.kind]}
          </Badge>
        </div>
        {asset.notes && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{asset.notes}</p>}
        <div className="flex items-center justify-end gap-1 mt-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          {/* Quick "move to folder" without opening the edit dialog (#198). */}
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            title="Move to folder"
            aria-label={`Move "${asset.name}" to a folder`}
            data-testid={`move-asset-${asset.id}`}
            onClick={() => onMove(asset)}
          >
            <Folder className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" asChild>
            <a href={fileUrl} download={asset.filename ?? asset.name} aria-label={`Download ${asset.name}`} data-testid={`download-asset-${asset.id}`}>
              <Download className="h-3.5 w-3.5" />
            </a>
          </Button>
          <EditAssetDialog asset={asset} onSaved={onChanged} />
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="icon" variant="ghost" className="h-8 w-8" disabled={deleting} aria-label={`Delete ${asset.name}`} data-testid={`delete-asset-${asset.id}`}>
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete "{asset.name}"?</AlertDialogTitle>
                <AlertDialogDescription>
                  The asset leaves the library and MCP clients immediately. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleDelete}
                  className="bg-destructive hover:bg-destructive/90"
                  data-testid={`confirm-delete-asset-${asset.id}`}
                >
                  Delete asset
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
  );
}

const FILTERS: { value: AssetKind | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "brand", label: "Brand" },
  { value: "reference", label: "Reference" },
];

export default function Assets() {
  const qc = useQueryClient();
  const [kindFilter, setKindFilter] = useState<AssetKind | "all">("all");
  const params = kindFilter === "all" ? undefined : { kind: kindFilter };
  const { data: assets, isLoading } = useListAssets(params);
  const search = useSearch();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  // "Move to folder" quick action from a card (#198). moveAsset is the asset
  // being moved; the dialog seeds its input from the asset's current folder.
  const [moveAsset, setMoveAsset] = useState<Asset | null>(null);
  const [moveFolder, setMoveFolder] = useState("");
  const { mutate: updateAsset, isPending: isMoving } = useUpdateAsset();

  function openMove(asset: Asset) {
    setMoveAsset(asset);
    setMoveFolder(asset.folder ?? "");
  }

  function handleMoveSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!moveAsset) return;
    const target = moveFolder.trim() || null;
    updateAsset(
      { id: moveAsset.id, data: { folder: target } },
      {
        onSuccess: () => {
          setMoveAsset(null);
          refetch();
          toast({
            title: target ? `Moved to "${target}"` : "Removed from folder",
            description: `"${moveAsset.name}"`,
          });
        },
        // PATCH /assets/:id is creator-or-admin; surface the 403 plainly.
        onError: () => toast({ title: "Failed to move asset", description: "Only an asset's creator or an admin can move it.", variant: "destructive" }),
      },
    );
  }

  // Folder drill-down (#159/#158) layered on top of the kind filter: ?folder=X
  // shows just that folder; no param shows the folder index + ungrouped assets.
  const folders = collectFolders(assets);
  const activeFolder = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("folder");
  const ungrouped = (assets ?? []).filter((a) => !a.folder);
  const inFolder = activeFolder != null ? (assets ?? []).filter((a) => a.folder === activeFolder) : [];

  function folderCovers(name: string): string[] {
    return (assets ?? [])
      .filter((a) => a.folder === name && a.contentType.startsWith("image/"))
      .map((a) => `/api/storage${a.storageKey}`)
      .slice(0, 4);
  }

  function refetch() {
    // Key without params is a prefix of every kind-filtered key, so this
    // invalidates all three filter views at once.
    qc.invalidateQueries({ queryKey: getListAssetsQueryKey() });
  }

  const assetGrid = (items: Asset[], testId = "assets-grid") => (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4" data-testid={testId}>
      {items.map((asset) => (
        <AssetCard key={asset.id} asset={asset} onChanged={refetch} onMove={openMove} />
      ))}
    </div>
  );

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="assets-page">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Assets</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Brand assets (logos to drop into deliverables) and reference works (past output to match) — also served to AI agents over MCP
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {(assets?.length ?? 0) > 0 && activeFolder == null && (
              <NewAssetFolderDialog
                assets={assets ?? []}
                folderSuggestions={folders}
                onCreated={(f) => { refetch(); navigate(`/assets?folder=${encodeURIComponent(f)}`); }}
              />
            )}
            <UploadAssetDialog onSaved={refetch} />
          </div>
        </div>

        <div className="flex items-center gap-1" data-testid="asset-kind-filter">
          {FILTERS.map((f) => (
            <Button
              key={f.value}
              size="sm"
              variant={kindFilter === f.value ? "secondary" : "ghost"}
              onClick={() => setKindFilter(f.value)}
              data-testid={`asset-filter-${f.value}`}
            >
              {f.label}
            </Button>
          ))}
        </div>

        {isLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="rounded-xl overflow-hidden border border-border">
                <Skeleton className="aspect-[4/3] w-full" />
                <div className="p-3 space-y-1.5">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : assets && assets.length > 0 ? (
          activeFolder != null ? (
            <div className="space-y-4">
              <FolderBreadcrumb rootHref="/assets" rootLabel="Assets" folder={activeFolder} />
              {inFolder.length > 0 ? assetGrid(inFolder) : (
                <p className="text-sm text-muted-foreground">This folder is empty.</p>
              )}
            </div>
          ) : folders.length > 0 ? (
            <div className="space-y-8">
              <div>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Folders</h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                  {folders.map((f) => (
                    <FolderCard
                      key={f}
                      name={f}
                      count={(assets ?? []).filter((a) => a.folder === f).length}
                      covers={folderCovers(f)}
                      href={`/assets?folder=${encodeURIComponent(f)}`}
                    />
                  ))}
                </div>
              </div>
              {ungrouped.length > 0 && (
                <div>
                  <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Ungrouped</h2>
                  {assetGrid(ungrouped)}
                </div>
              )}
            </div>
          ) : (
            assetGrid(assets)
          )
        ) : (
          <div className="flex flex-col items-center justify-center py-24 text-center" data-testid="assets-empty">
            <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center mb-4">
              {kindFilter === "all" ? <Palette className="h-7 w-7 text-muted-foreground" /> : <Upload className="h-7 w-7 text-muted-foreground" />}
            </div>
            <h3 className="text-base font-medium text-foreground mb-1">
              {kindFilter === "all" ? "No assets yet" : `No ${KIND_LABEL[kindFilter as AssetKind].toLowerCase()} assets yet`}
            </h3>
            <p className="text-sm text-muted-foreground max-w-sm mb-6">
              Upload logos and past works so people — and AI agents over MCP — always pull the right file for a project.
            </p>
            <UploadAssetDialog onSaved={refetch} testId="upload-asset-btn-empty" />
          </div>
        )}

        {/* Move-to-folder dialog for the card quick action (#198). */}
        <Dialog open={moveAsset !== null} onOpenChange={(open) => { if (!open) setMoveAsset(null); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Move to folder</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleMoveSubmit} className="space-y-4 pt-2">
              <div className="space-y-1.5">
                <Label htmlFor="move-asset-folder">
                  Folder for <span className="font-medium">{moveAsset?.name}</span>
                </Label>
                <Input
                  id="move-asset-folder"
                  value={moveFolder}
                  onChange={(e) => setMoveFolder(e.target.value)}
                  placeholder='e.g. "Logos" — leave empty to ungroup'
                  list="move-asset-folder-options"
                  autoFocus
                  data-testid="move-asset-folder-input"
                />
                <datalist id="move-asset-folder-options">
                  {folders.map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
              </div>
              <div className="flex justify-end gap-3">
                <Button type="button" variant="outline" onClick={() => setMoveAsset(null)}>Cancel</Button>
                <Button type="submit" disabled={isMoving} data-testid="move-asset-submit">
                  {isMoving ? "Moving..." : "Move"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}
