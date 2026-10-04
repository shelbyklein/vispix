import { useState } from "react";
import { photoControlLabel, photoAltText } from "@/lib/photo-a11y";
import { useParams, Link, useLocation } from "wouter";
import {
  useGetProject,
  useUpdateProject,
  useDeleteProject,
  useRemovePhotoFromProject,
  getGetProjectQueryKey,
  getListProjectsQueryKey,
  useGetMe,
} from "@workspace/api-client-react";
import type { Photo } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { formatDate } from "@/lib/format-date";
import { FadeImage } from "@/components/ui/fade-image";
import { PhotoGrid } from "@/components/PhotoGrid";
import { GridZoomControl } from "@/components/GridZoomControl";
import { useGridZoom } from "@/hooks/useGridZoom";
import { startPhotoDrag } from "@/lib/photoDrag";
import { PhotoLightbox, type LightboxPhoto } from "@/components/PhotoLightbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
import { ArrowLeft, FolderKanban, Pencil, Trash2, Star, X, CalendarDays, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCapabilities } from "@/hooks/useCapabilities";

function toLight(photo: Photo): LightboxPhoto {
  return {
    id: photo.id,
    url: photo.url,
    thumbnailKey: photo.thumbnailKey,
    name: photo.filename,
    averageRating: photo.averageRating,
    albumId: photo.albumId,
  };
}

function RenameProjectDialog({
  projectId,
  currentName,
  currentDescription,
  onUpdated,
}: {
  projectId: number;
  currentName: string;
  currentDescription?: string | null;
  onUpdated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(currentName);
  const [description, setDescription] = useState(currentDescription ?? "");
  const { mutate: updateProject, isPending } = useUpdateProject();
  const { toast } = useToast();

  function handleOpenChange(next: boolean) {
    if (next) {
      setName(currentName);
      setDescription(currentDescription ?? "");
    }
    setOpen(next);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    updateProject(
      {
        id: projectId,
        data: {
          name: name.trim(),
          description: description.trim() || null,
        },
      },
      {
        onSuccess: () => {
          setOpen(false);
          onUpdated();
          toast({ title: "Project updated" });
        },
        onError: () => toast({ title: "Failed to update project", variant: "destructive" }),
      }
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" data-testid="rename-project-btn">
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Project</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="rename-project-name">Name *</Label>
            <Input
              id="rename-project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              data-testid="rename-project-name-input"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rename-project-desc">Description</Label>
            <Textarea
              id="rename-project-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              data-testid="rename-project-desc-input"
            />
          </div>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || !name.trim()} data-testid="rename-project-submit">
              {isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const projectId = parseInt(id, 10);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [selectedPhoto, setSelectedPhoto] = useState<LightboxPhoto | null>(null);
  const { zoom, setZoom } = useGridZoom();

  const { data: project, isLoading } = useGetProject(projectId, {
    query: { enabled: !!projectId, queryKey: getGetProjectQueryKey(projectId) },
  });
  const { data: me } = useGetMe();
  const caps = useCapabilities();
  const { mutate: deleteProject, isPending: deletingProject } = useDeleteProject();
  const { mutate: removePhoto } = useRemovePhotoFromProject();

  function invalidate() {
    qc.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
    qc.invalidateQueries({ queryKey: getListProjectsQueryKey() });
  }

  function handleDeleteProject() {
    deleteProject(
      { id: projectId },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          toast({ title: "Project deleted" });
          navigate("/projects");
        },
        onError: () => toast({ title: "Failed to delete project", variant: "destructive" }),
      }
    );
  }

  const canManage =
    !!project && caps.canManageItem(project.createdById);

  const photos = project?.photos ?? [];
  const selectedIndex = selectedPhoto ? photos.findIndex((p) => p.id === selectedPhoto.id) : -1;
  const hasPrev = selectedIndex > 0;
  const hasNext = selectedIndex >= 0 && selectedIndex < photos.length - 1;

  if (isLoading) {
    return (
      <AppLayout>
        <div className="space-y-6">
          <Skeleton className="h-8 w-64" />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[4/3] rounded-lg" />
            ))}
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!project) {
    return (
      <AppLayout>
        <div className="text-center py-24">
          <p className="text-muted-foreground">Project not found.</p>
          <Link href="/projects">
            <Button variant="outline" className="mt-4">
              Back to Projects
            </Button>
          </Link>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="project-detail-page">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <Link href="/projects">
              <Button
                variant="ghost"
                size="icon"
                className="mt-0.5 shrink-0"
                data-testid="back-to-projects"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div className="space-y-1">
              <h1 className="text-2xl font-bold text-foreground" data-testid="project-name">
                {project.name}
              </h1>
              <p className="text-sm text-muted-foreground">
                {project.photoCount} photo{project.photoCount !== 1 ? "s" : ""}
              </p>
              {project.description && (
                <p className="text-sm text-muted-foreground max-w-xl">
                  {project.description}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground pt-1">
                <span className="flex items-center gap-1.5">
                  <CalendarDays className="h-3.5 w-3.5" />
                  Created {formatDate(project.createdAt)}
                </span>
                <span>Updated {formatDate(project.updatedAt)}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {project.photoCount > 0 && (
              <Button asChild variant="outline" size="sm" className="gap-1.5" data-testid="bulk-download-btn">
                {/* Plain link: the browser streams the zip and shows its own
                    download progress; no client-side buffering. */}
                <a href={`/api/projects/${projectId}/download`}>
                  <Download className="h-4 w-4" />
                  <span className="hidden sm:inline">Bulk download</span>
                </a>
              </Button>
            )}
            {canManage && (
              <>
              <RenameProjectDialog
                projectId={projectId}
                currentName={project.name}
                currentDescription={project.description}
                onUpdated={invalidate}
              />
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    data-testid="delete-project-btn"
                    title="Delete project"
                  >
                    <Trash2 className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this project?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete "{project.name}". The photos themselves will
                      not be affected.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDeleteProject}
                      disabled={deletingProject}
                      className="bg-destructive hover:bg-destructive/90"
                      data-testid="confirm-delete-project"
                    >
                      {deletingProject ? "Deleting…" : "Delete Project"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              </>
            )}
          </div>
        </div>

        {photos.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center py-24 text-center border-2 border-dashed border-border rounded-xl"
            data-testid="no-project-photos"
          >
            <FolderKanban className="h-10 w-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium text-foreground mb-1">No photos yet</p>
            <p className="text-xs text-muted-foreground mb-4 max-w-sm">
              Open a photo's detail page and add it to this project from the Projects section.
            </p>
          </div>
        ) : (
          <>
          <div className="flex items-center justify-end">
            <GridZoomControl zoom={zoom} setZoom={setZoom} />
          </div>
          <PhotoGrid
            items={photos}
            getKey={(photo) => photo.id}
            densityOverride={zoom}
            data-testid="project-photo-grid"
            renderItem={(photo) => (
              <div
                key={photo.id}
                draggable
                onDragStart={(e) => startPhotoDrag(e, photo.id)}
                className="relative group h-full rounded-lg overflow-hidden bg-muted"
                data-testid="project-photo-item"
              >
                <button
                  type="button"
                  onClick={() => setSelectedPhoto(toLight(photo))}
                  className="block w-full h-full focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
                  aria-label={photoControlLabel("Preview", photo)}
                  data-photo-id={photo.id}
                >
                  <FadeImage
                    loading="lazy"
                    src={photo.thumbnailKey ? `/api/storage${photo.thumbnailKey}` : photo.url}
                    alt={photoAltText(photo.aiDescription)}
                    className="w-full h-full object-cover cursor-pointer transition-transform duration-200 group-hover:scale-105"
                  />
                </button>

                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-all duration-200 pointer-events-none" />

                {photo.averageRating != null && (
                  <div className="absolute top-2 left-2 flex items-center gap-0.5 bg-black/60 rounded px-1.5 py-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 transition-opacity">
                    <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                    <span className="text-xs text-white font-medium">
                      {photo.averageRating.toFixed(1)}
                    </span>
                  </div>
                )}

                {canManage && (
                  <button
                    type="button"
                    data-testid="remove-from-project-btn"
                    onClick={() =>
                      removePhoto(
                        { id: projectId, photoId: photo.id },
                        {
                          onSuccess: () => {
                            invalidate();
                            toast({ title: "Photo removed from project" });
                          },
                          onError: () =>
                            toast({ title: "Failed to remove photo", variant: "destructive" }),
                        }
                      )
                    }
                    className="absolute bottom-2 left-2 flex items-center gap-1 bg-black/70 hover:bg-red-600 text-white rounded px-2 py-1 text-[10px] font-medium opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 transition-opacity"
                  >
                    <X className="h-2.5 w-2.5" />
                    Remove
                  </button>
                )}
              </div>
            )}
          />
          </>
        )}
      </div>

      <PhotoLightbox
        photo={selectedPhoto}
        onClose={() => setSelectedPhoto(null)}
        hasPrev={hasPrev}
        hasNext={hasNext}
        onPrev={() => hasPrev && setSelectedPhoto(toLight(photos[selectedIndex - 1]))}
        onNext={() => hasNext && setSelectedPhoto(toLight(photos[selectedIndex + 1]))}
      />
    </AppLayout>
  );
}
