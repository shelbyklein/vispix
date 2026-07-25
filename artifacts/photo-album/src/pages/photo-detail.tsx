import { useState, useEffect } from "react";
import { useParams, Link } from "wouter";
import {
  useGetPhoto,
  useListAlbumPhotos,
  useDeletePhoto,
  useListCollections,
  useAddPhotoToCollection,
  useRemovePhotoFromCollection,
  useAcceptPhotoSuggestion,
  useDismissPhotoSuggestion,
  useAcceptPhotoNewCollectionSuggestion,
  useDismissPhotoNewCollectionSuggestion,
  useRerunPhotoAnalysis,
  useUpdatePhoto,
  useCreateCollection,
  useListProjects,
  useAddPhotoToProject,
  getGetPhotoQueryKey,
  getListAlbumPhotosQueryKey,
  getListPhotosQueryKey,
  getGetRecentPhotosQueryKey,
  getGetTopRatedPhotosQueryKey,
  getListCollectionsQueryKey,
  getListProjectsQueryKey,
  getGetProjectQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetMe } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { formatDate } from "@/lib/format-date";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { CalendarDays, EyeOff } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { PhotoDetailHeader } from "@/components/photo-detail/PhotoDetailHeader";
import { AiDescriptionPanel } from "@/components/photo-detail/AiDescriptionPanel";
import { AiEvaluationPanel } from "@/components/photo-detail/AiEvaluationPanel";
import { RatingsPanel } from "@/components/photo-detail/RatingsPanel";
import { CollectionsPanel } from "@/components/photo-detail/CollectionsPanel";
import { AttributionPanel } from "@/components/photo-detail/AttributionPanel";
import { PhotoActions } from "@/components/photo-detail/PhotoActions";
import { SimilarPhotosPanel } from "@/components/photo-detail/SimilarPhotosPanel";
import {
  ConfirmNewCollectionDialog,
  type ConfirmNewCollectionState,
} from "@/components/photo-detail/ConfirmNewCollectionDialog";

export default function PhotoDetail() {
  const { id } = useParams<{ id: string }>();
  const photoId = parseInt(id, 10);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const { data: photo, isLoading } = useGetPhoto(photoId, {
    query: {
      enabled: !!photoId,
      queryKey: getGetPhotoQueryKey(photoId),
      refetchInterval: (q) => {
        const data = q.state.data as { aiDescription?: string | null; createdAt?: string } | undefined;
        if (!data || data.aiDescription != null) return false;
        const created = data.createdAt ? new Date(data.createdAt).getTime() : 0;
        if (!created || Date.now() - created > 60_000) return false;
        return 3000;
      },
    },
  });
  const { data: me } = useGetMe();
  const { data: allCollections } = useListCollections();
  const { data: allProjects } = useListProjects();
  const { mutate: addToCollection } = useAddPhotoToCollection();
  const { mutate: addToProject } = useAddPhotoToProject();
  const { mutate: removeFromCollection } = useRemovePhotoFromCollection();
  const { mutate: acceptSuggestion } = useAcceptPhotoSuggestion();
  const { mutate: dismissSuggestion } = useDismissPhotoSuggestion();
  const { mutate: acceptNewCollectionSuggestion, isPending: acceptingNewCollection } = useAcceptPhotoNewCollectionSuggestion();
  const { mutate: dismissNewCollectionSuggestion } = useDismissPhotoNewCollectionSuggestion();
  const { mutate: deletePhoto, isPending: deleting } = useDeletePhoto();
  const { mutate: rerunAnalysis, isPending: rerunning } = useRerunPhotoAnalysis();
  const { mutate: updatePhoto, isPending: savingDescription } = useUpdatePhoto();
  const { mutate: createCollection, isPending: creatingCollection } = useCreateCollection();
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [newCollectionName, setNewCollectionName] = useState("");
  const [confirmNewCollection, setConfirmNewCollection] = useState<ConfirmNewCollectionState>(null);

  const { data: albumPhotos } = useListAlbumPhotos(
    photo?.albumId ?? 0,
    undefined,
    { query: { enabled: !!photo?.albumId, queryKey: getListAlbumPhotosQueryKey(photo?.albumId ?? 0, undefined) } },
  );

  const albumPhotosList = albumPhotos?.photos ?? [];
  const currentIndex = albumPhotosList.length > 0 ? albumPhotosList.findIndex((p) => p.id === photoId) : -1;
  const prevPhotoId = currentIndex > 0 ? albumPhotosList[currentIndex - 1].id : null;
  const nextPhotoId = currentIndex >= 0 && currentIndex < albumPhotosList.length - 1 ? albumPhotosList[currentIndex + 1].id : null;

  useEffect(() => {
    setEditingDescription(false);
    setDescriptionDraft("");
  }, [photoId]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      const target = e.target as Element | null;
      if (!target) return;
      const tag = (target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((target as HTMLElement).isContentEditable) return;
      if (target.closest('[role="listbox"], [role="menu"], [role="dialog"], [role="combobox"]')) return;
      if (e.key === "ArrowLeft" && prevPhotoId != null) {
        e.preventDefault();
        navigate(`/photos/${prevPhotoId}`);
      } else if (e.key === "ArrowRight" && nextPhotoId != null) {
        e.preventDefault();
        navigate(`/photos/${nextPhotoId}`);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [prevPhotoId, nextPhotoId, navigate]);

  function invalidate() {
    qc.invalidateQueries({ queryKey: getGetPhotoQueryKey(photoId) });
    if (photo?.albumId) {
      qc.invalidateQueries({ queryKey: getListAlbumPhotosQueryKey(photo.albumId) });
    }
    qc.invalidateQueries({ queryKey: getListPhotosQueryKey().slice(0, 1) });
    qc.invalidateQueries({ queryKey: getGetRecentPhotosQueryKey() });
    qc.invalidateQueries({ queryKey: getGetTopRatedPhotosQueryKey() });
  }

  function handleAcceptSuggestion(collectionId: number) {
    acceptSuggestion(
      { id: photoId, collectionId },
      { onSuccess: invalidate, onError: () => toast({ title: "Failed to accept suggestion", variant: "destructive" }) }
    );
  }

  function handleDismissSuggestion(collectionId: number) {
    dismissSuggestion(
      { id: photoId, collectionId },
      { onSuccess: invalidate, onError: () => toast({ title: "Failed to dismiss suggestion", variant: "destructive" }) }
    );
  }

  function handleAcceptNewCollectionSuggestion(suggestionId: number, name: string) {
    acceptNewCollectionSuggestion(
      { id: photoId, suggestionId, data: { name } },
      {
        onSuccess: () => {
          setConfirmNewCollection(null);
          invalidate();
          qc.invalidateQueries({ queryKey: getListCollectionsQueryKey() });
          toast({ title: "Collection created and photo added" });
        },
        onError: () => toast({ title: "Failed to accept suggestion", variant: "destructive" }),
      }
    );
  }

  function handleDismissNewCollectionSuggestion(suggestionId: number) {
    dismissNewCollectionSuggestion(
      { id: photoId, suggestionId },
      { onSuccess: invalidate, onError: () => toast({ title: "Failed to dismiss suggestion", variant: "destructive" }) }
    );
  }

  function handleAddCollection(collectionId: string) {
    addToCollection(
      { id: parseInt(collectionId, 10), data: { photoId } },
      { onSuccess: invalidate, onError: () => toast({ title: "Failed to add to collection", variant: "destructive" }) }
    );
  }

  function handleAddProject(projectId: string) {
    const id = parseInt(projectId, 10);
    const project = allProjects?.find((p) => p.id === id);
    addToProject(
      { id, data: { photoId } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          qc.invalidateQueries({ queryKey: getGetProjectQueryKey(id) });
          toast({ title: project ? `Added to "${project.name}"` : "Added to project" });
        },
        onError: () => toast({ title: "Failed to add to project", variant: "destructive" }),
      }
    );
  }

  function handleCreateNewCollection(e: React.FormEvent) {
    e.preventDefault();
    const name = newCollectionName.trim();
    if (!name) return;
    createCollection(
      { data: { title: name } },
      {
        onSuccess: (newCol) => {
          setNewCollectionName("");
          qc.invalidateQueries({ queryKey: getListCollectionsQueryKey() });
          addToCollection(
            { id: newCol.id, data: { photoId } },
            {
              onSuccess: () => {
                invalidate();
                toast({ title: `Added to "${name}"` });
              },
              onError: () => toast({ title: "Collection created but failed to add photo", variant: "destructive" }),
            }
          );
        },
        onError: () => toast({ title: "Failed to create collection", variant: "destructive" }),
      }
    );
  }

  function handleRemoveFromCollection(collectionId: number) {
    removeFromCollection(
      { id: collectionId, photoId },
      { onSuccess: invalidate, onError: () => toast({ title: "Failed to remove from collection", variant: "destructive" }) }
    );
  }

  function handleDelete() {
    deletePhoto(
      { id: photoId },
      {
        onSuccess: () => {
          toast({ title: "Photo deleted" });
          if (photo?.albumId) navigate(`/albums/${photo.albumId}`);
          else navigate("/albums");
        },
        onError: () => toast({ title: "Failed to delete photo", variant: "destructive" }),
      }
    );
  }

  function handleRerunAnalysis() {
    rerunAnalysis(
      { id: photoId },
      {
        onSuccess: () => {
          toast({ title: "AI analysis started" });
          qc.invalidateQueries({ queryKey: getGetPhotoQueryKey(photoId) });
        },
        onError: () => toast({ title: "Failed to start AI analysis", variant: "destructive" }),
      }
    );
  }

  function handleStartEditDescription() {
    setDescriptionDraft(photo?.aiDescription ?? "");
    setEditingDescription(true);
  }

  function handleCancelEditDescription() {
    setEditingDescription(false);
    setDescriptionDraft("");
  }

  function handleSaveDescription() {
    updatePhoto(
      { id: photoId, data: { aiDescription: descriptionDraft.trim() || null } },
      {
        onSuccess: () => {
          toast({ title: "Description saved" });
          setEditingDescription(false);
          setDescriptionDraft("");
          qc.invalidateQueries({ queryKey: getGetPhotoQueryKey(photoId) });
        },
        onError: () => toast({ title: "Failed to save description", variant: "destructive" }),
      }
    );
  }

  const availableCollections = allCollections?.filter(
    (col) => !photo?.photoCollections?.some((c) => c.id === col.id)
  );

  const canDelete = me && photo && (me.id === photo.uploaderId || me.role === "admin");
  const canRerunAnalysis = me && photo && (me.id === photo.uploaderId || me.role === "admin");
  const canEditDescription = me && photo && (me.id === photo.uploaderId || me.role === "admin");
  const canToggleHidden = me && photo && (me.id === photo.uploaderId || me.role === "admin");

  function handleToggleHidden() {
    if (!photo) return;
    const next = !photo.isHidden;
    updatePhoto(
      { id: photoId, data: { isHidden: next } },
      {
        onSuccess: () => {
          toast({ title: next ? "Photo hidden" : "Photo visible again" });
          invalidate();
        },
        onError: () => toast({ title: "Failed to update photo", variant: "destructive" }),
      }
    );
  }

  if (isLoading) {
    return (
      <AppLayout>
        <div className="grid lg:grid-cols-[1fr_320px] gap-8">
          <Skeleton className="aspect-[4/3] w-full rounded-xl" />
          <div className="space-y-4">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!photo) {
    return (
      <AppLayout>
        <div className="text-center py-24">
          <p className="text-muted-foreground">Photo not found.</p>
          <Link href="/albums"><Button variant="outline" className="mt-4">Back to Albums</Button></Link>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="photo-detail-page">
        <PhotoDetailHeader
          albumId={photo.albumId}
          albumTitle={photo.albumTitle}
          prevPhotoId={prevPhotoId}
          nextPhotoId={nextPhotoId}
          hasAlbumPhotos={!!albumPhotos}
          currentIndex={currentIndex}
          totalPhotos={albumPhotosList.length}
          onNavigate={(pid) => navigate(`/photos/${pid}`)}
        />

        <div className="grid lg:grid-cols-[1fr_320px] gap-8">
          <div className="space-y-3">
            <div className="relative rounded-xl overflow-hidden bg-muted aspect-[4/3]">
              <img
                src={photo.url}
                alt="Photo"
                className={`h-full w-full object-contain bg-black${photo.isHidden ? " opacity-60" : ""}`}
                data-testid="photo-image"
              />
              {photo.isHidden && (
                <div
                  className="absolute top-3 left-3 flex items-center gap-1 rounded-full bg-black/70 px-2 py-1"
                  data-testid="photo-hidden-badge"
                >
                  <EyeOff className="h-3.5 w-3.5 text-white" />
                  <span className="text-xs font-semibold text-white">Hidden</span>
                </div>
              )}
            </div>
            <AiDescriptionPanel
              aiDescription={photo.aiDescription}
              createdAt={photo.createdAt}
              suggestedCollections={photo.suggestedCollections}
              suggestedNewCollections={photo.suggestedNewCollections}
              canEditDescription={!!canEditDescription}
              canRerunAnalysis={!!canRerunAnalysis}
              editingDescription={editingDescription}
              descriptionDraft={descriptionDraft}
              setDescriptionDraft={setDescriptionDraft}
              savingDescription={savingDescription}
              rerunning={rerunning}
              onStartEdit={handleStartEditDescription}
              onCancelEdit={handleCancelEditDescription}
              onSave={handleSaveDescription}
              onRerun={handleRerunAnalysis}
              onAcceptSuggestion={handleAcceptSuggestion}
              onDismissSuggestion={handleDismissSuggestion}
              onCreateNewCollection={(s) => setConfirmNewCollection(s)}
              onDismissNewCollectionSuggestion={handleDismissNewCollectionSuggestion}
            />
            {photo.aiEvaluation && <AiEvaluationPanel evaluation={photo.aiEvaluation} />}
          </div>

          <div className="space-y-6">
            <div className="space-y-3">
              <div className="space-y-1.5 text-sm text-muted-foreground">
                {photo.takenAt && (
                  <div className="flex items-center gap-2">
                    <CalendarDays className="h-3.5 w-3.5" />
                    <span>{formatDate(photo.takenAt)}</span>
                  </div>
                )}
              </div>
            </div>

            <RatingsPanel
              photo={photo}
              photoId={photoId}
              currentUserId={me?.id}
              onRated={invalidate}
            />

            <Separator />

            <CollectionsPanel
              photoCollections={photo.photoCollections}
              availableCollections={availableCollections}
              aiDescription={photo.aiDescription}
              projects={allProjects}
              newCollectionName={newCollectionName}
              setNewCollectionName={setNewCollectionName}
              creatingCollection={creatingCollection}
              onAddCollection={handleAddCollection}
              onRemoveFromCollection={handleRemoveFromCollection}
              onCreateNewCollection={handleCreateNewCollection}
              onAddProject={handleAddProject}
            />

            <AttributionPanel photoTags={photo.attributionTags} />

            <Separator />

            <PhotoActions
              photoUrl={photo.url}
              photoId={photo.id}
              isHidden={photo.isHidden}
              canToggleHidden={!!canToggleHidden}
              canDelete={!!canDelete}
              deleting={deleting}
              onToggleHidden={handleToggleHidden}
              onDelete={handleDelete}
            />
          </div>
        </div>

        <SimilarPhotosPanel photoId={photoId} />
      </div>
      <ConfirmNewCollectionDialog
        confirmNewCollection={confirmNewCollection}
        setConfirmNewCollection={setConfirmNewCollection}
        acceptingNewCollection={acceptingNewCollection}
        onAccept={handleAcceptNewCollectionSuggestion}
      />
    </AppLayout>
  );
}
