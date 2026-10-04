import { useState, useEffect, useMemo } from "react";
import { useParams, Link } from "wouter";
import {
  useGetPhoto,
  useGetPhotoNeighbors,
  getGetPhotoNeighborsQueryKey,
  type GetPhotoNeighborsParams,
  type GetPhotoNeighborsAiStatus,
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
import { formatDimensions, formatFileSize, photoAltText, photoName } from "@/lib/photo-a11y";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { CalendarDays, EyeOff } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLocation, useSearch } from "wouter";
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
import { useCapabilities } from "@/hooks/useCapabilities";

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
  const caps = useCapabilities();
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

  // Previous/Next (#210): resolved server-side within the view the photo was
  // opened from — the album + filters carried in this URL's query string by
  // the album page — or, for a direct link, the photo's own album. Stepping
  // keeps the query string, so the whole walk stays in that view.
  const search = useSearch();
  const neighborParams = useMemo<GetPhotoNeighborsParams>(() => {
    const p = new URLSearchParams(search);
    const int = (k: string) => {
      const n = parseInt(p.get(k) ?? "", 10);
      return Number.isInteger(n) ? n : undefined;
    };
    const bool = (k: string) => (p.get(k) === "true" ? true : p.get(k) === "false" ? false : undefined);
    // Opened from search (#210 NAV-03): follow the search's result order. The
    // URL carries the search page's own parameters.
    const q = p.get("q")?.trim();
    if (q) {
      const num = (k: string) => {
        const n = Number(p.get(k));
        return p.get(k) && Number.isFinite(n) ? n : undefined;
      };
      const exclude = (p.get("exclude") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      const s: GetPhotoNeighborsParams = {
        q,
        mode: p.get("mode") === "keyword" ? "keyword" : "combined",
        ratingMin: num("ratingMin"),
        ratingMax: num("ratingMax"),
        minQuality: num("minQuality"),
        dateFrom: p.get("dateFrom") || undefined,
        dateTo: p.get("dateTo") || undefined,
        uploaderId: int("uploaderId"),
        includeHidden: p.get("hidden") === "1" ? true : undefined,
        ...(exclude.length ? { exclude } : {}),
      };
      return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as GetPhotoNeighborsParams;
    }
    const aiStatus = p.get("aiStatus");
    const out: GetPhotoNeighborsParams = {
      albumId: int("albumId"),
      includeHidden: bool("includeHidden"),
      inCollection: bool("inCollection"),
      hasRating: bool("hasRating"),
      aiStatus: aiStatus === "has_description" || aiStatus === "failed" || aiStatus === "not_analysed" ? (aiStatus as GetPhotoNeighborsAiStatus) : undefined,
      attributionTagId: int("attributionTagId"),
      hasAttribution: bool("hasAttribution"),
    };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as GetPhotoNeighborsParams;
  }, [search]);
  const photoHref = (id: number) => `/photos/${id}${search ? `?${search}` : ""}`;
  const searchBack = useMemo(() => {
    const p = new URLSearchParams(search);
    const q = p.get("q")?.trim();
    return q ? { href: `/search?${p.toString()}`, label: `Search: “${q.length > 30 ? `${q.slice(0, 30)}…` : q}”` } : null;
  }, [search]);
  const neighbors = useGetPhotoNeighbors(photoId, neighborParams, {
    query: { enabled: !!photo, queryKey: getGetPhotoNeighborsQueryKey(photoId, neighborParams), retry: 1 },
  });
  const prevPhotoId = neighbors.data?.previousId ?? null;
  const nextPhotoId = neighbors.data?.nextId ?? null;
  const navState = neighbors.isError
    ? "error"
    : !neighbors.data
      ? "loading"
      : neighbors.data.inContext
        ? "ready"
        : "outside";

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
        navigate(photoHref(prevPhotoId));
      } else if (e.key === "ArrowRight" && nextPhotoId != null) {
        e.preventDefault();
        navigate(photoHref(nextPhotoId));
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [prevPhotoId, nextPhotoId, navigate, search]);

  function invalidate() {
    qc.invalidateQueries({ queryKey: getGetPhotoQueryKey(photoId) });
    qc.invalidateQueries({ queryKey: getGetPhotoNeighborsQueryKey(photoId, neighborParams) });
    if (photo?.albumId) {
      qc.invalidateQueries({ queryKey: getListAlbumPhotosQueryKey(photo.albumId) });
    }
    qc.invalidateQueries({ queryKey: getListPhotosQueryKey().slice(0, 1) });
    qc.invalidateQueries({ queryKey: getGetRecentPhotosQueryKey() });
    qc.invalidateQueries({ queryKey: getGetTopRatedPhotosQueryKey() });
    // Membership and recommendation counts shown on collection cards.
    qc.invalidateQueries({ queryKey: getListCollectionsQueryKey() });
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

  // Uploader or org owner/admin (#218).
  const canManagePhoto = !!photo && caps.canManageItem(photo.uploaderId);
  const canDelete = canManagePhoto;
  const canRerunAnalysis = canManagePhoto;
  const canEditDescription = canManagePhoto;
  const canToggleHidden = canManagePhoto;

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
          <span role="status" className="sr-only">Loading photo…</span>
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
          <h1 className="text-xl font-semibold" role="alert">Photo not found</h1>
          <Button asChild variant="outline" className="mt-4"><Link href="/albums">Back to Albums</Link></Button>
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
          navState={navState}
          position={neighbors.data?.position ?? null}
          totalPhotos={neighbors.data?.total ?? 0}
          onNavigate={(pid) => navigate(photoHref(pid))}
          onRetry={() => void neighbors.refetch()}
          fallbackHref={search ? `/photos/${photoId}` : null}
          back={searchBack}
          exploreHref={`/photos/${photoId}/graph?from=${encodeURIComponent(`/photos/${photoId}${search ? `?${search}` : ""}`)}`}
        />

        <div className="grid lg:grid-cols-[1fr_320px] gap-8">
          <div className="space-y-3">
            <div className="relative rounded-xl overflow-hidden bg-muted aspect-[4/3]">
              <img
                src={photo.url}
                alt={photoAltText(photo.aiDescription)}
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
              <div>
                <h1 className="text-xl font-semibold break-words" data-testid="photo-title">
                  {photoName(photo)}
                </h1>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm text-muted-foreground" data-testid="photo-facts">
                  <dt>Photo ID</dt>
                  <dd data-testid="photo-id">{photo.id}</dd>
                  {photo.albumTitle && (
                    <>
                      <dt>Album</dt>
                      <dd>{photo.albumTitle}</dd>
                    </>
                  )}
                  {formatDimensions(photo.width, photo.height) && (
                    <>
                      <dt>Dimensions</dt>
                      <dd data-testid="photo-dimensions">{formatDimensions(photo.width, photo.height)}</dd>
                    </>
                  )}
                  {formatFileSize(photo.filesize) && (
                    <>
                      <dt>File size</dt>
                      <dd data-testid="photo-filesize">{formatFileSize(photo.filesize)}</dd>
                    </>
                  )}
                </dl>
              </div>
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
              projects={allProjects}
              newCollectionName={newCollectionName}
              setNewCollectionName={setNewCollectionName}
              creatingCollection={creatingCollection}
              onAddCollection={handleAddCollection}
              onRemoveFromCollection={handleRemoveFromCollection}
              onCreateNewCollection={handleCreateNewCollection}
              onAddProject={handleAddProject}
            />

            <AttributionPanel photoTags={photo.attributionTags} usageRights={photo.usageRights} albumId={photo.albumId} />

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
