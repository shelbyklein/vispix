import { useRef, useState } from "react";
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
import { useUpload } from "@workspace/object-storage-web";
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
import { Plus, Palette, Download, Pencil, Trash2, Upload, FileImage } from "lucide-react";
import { useSearch } from "wouter";
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
}: {
  fields: AssetFields;
  setFields: (f: AssetFields) => void;
  idPrefix: string;
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

function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

function UploadAssetDialog({ onSaved, testId = "upload-asset-btn" }: { onSaved: () => void; testId?: string }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fields, setFields] = useState<AssetFields>({ kind: "brand", name: "", variant: "", notes: "", folder: "", projectId: GLOBAL });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { uploadFile, isUploading } = useUpload();
  const { mutate: createAsset, isPending: creating } = useCreateAsset();
  const { toast } = useToast();

  const busy = isUploading || creating;

  function reset() {
    setFile(null);
    setFields({ kind: "brand", name: "", variant: "", notes: "", folder: "", projectId: GLOBAL });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    setFile(picked);
    if (picked && !fields.name.trim()) {
      setFields((cur) => ({ ...cur, name: stripExtension(picked.name) }));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !fields.name.trim() || busy) return;

    const uploaded = await uploadFile(file);
    if (!uploaded) {
      toast({ title: "Upload failed", variant: "destructive" });
      return;
    }

    createAsset(
      {
        data: {
          kind: fields.kind,
          name: fields.name.trim(),
          variant: fields.variant.trim() || undefined,
          notes: fields.notes.trim() || undefined,
          folder: fields.folder.trim() || undefined,
          projectId: fields.projectId === GLOBAL ? undefined : parseInt(fields.projectId, 10),
          storageKey: uploaded.objectPath,
          contentType: file.type || "application/octet-stream",
          filename: file.name,
          fileSize: file.size,
        },
      },
      {
        onSuccess: () => {
          setOpen(false);
          reset();
          onSaved();
          toast({ title: "Asset added", description: `"${fields.name.trim()}" is in the library.` });
        },
        onError: () => toast({ title: "Failed to save asset", variant: "destructive" }),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) reset(); }}>
      <DialogTrigger asChild>
        <Button className="gap-2" data-testid={testId}>
          <Plus className="h-4 w-4" />
          Add Asset
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Asset</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="asset-file">File * (SVG, PNG, JPEG…)</Label>
            <Input
              id="asset-file"
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              required
              data-testid="asset-file-input"
            />
          </div>
          <AssetFieldInputs fields={fields} setFields={setFields} idPrefix="asset-new" />
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !file || !fields.name.trim()} data-testid="asset-upload-submit">
              {isUploading ? "Uploading…" : creating ? "Saving…" : "Add to Library"}
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

function AssetCard({ asset, onChanged }: { asset: Asset; onChanged: () => void }) {
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
        <AssetCard key={asset.id} asset={asset} onChanged={refetch} />
      ))}
    </div>
  );

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="assets-page">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Assets</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Brand assets (logos to drop into deliverables) and reference works (past output to match) — also served to AI agents over MCP
            </p>
          </div>
          <UploadAssetDialog onSaved={refetch} />
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
      </div>
    </AppLayout>
  );
}
