import { useState, useRef, useEffect, type DragEvent, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { useSession, signOut, authClient } from "@/lib/auth-client";
import {
  useGetMe,
  useListProjects,
  useAddPhotoToProject,
  useListCollections,
  useAddPhotoToCollection,
  useUpdateNavOrder,
  getGetMeQueryKey,
  getListProjectsQueryKey,
  getGetProjectQueryKey,
  getListCollectionsQueryKey,
  getGetCollectionQueryKey,
  getGetPhotoQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { LayoutDashboard, Images, Shield, LogOut, ChevronsUpDown, Search, Grid2x2, FolderOpen, FolderKanban, Settings, Upload, Pause, Play, CheckCircle2, X, Sparkles, Sun, Moon, ChevronRight, Users, Palette, Building2, Check, Wand2, UserPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";
import { useOrg } from "@/contexts/OrgContext";
import { useToast } from "@/hooks/use-toast";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { isPhotoDrag, getDraggedPhotoId, PHOTO_DND_MIME } from "@/lib/photoDrag";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useBulkUploadOptional } from "@/contexts/BulkUploadContext";
import { useIsMobile } from "@/hooks/use-mobile";
import { DevEnvironmentBadge } from "@/components/DevEnvironmentBadge";
import { usePhotoUploadOptional } from "@/contexts/PhotoUploadContext";
import { PhotoUploadBanner } from "@/components/PhotoUploadBanner";
import { CreatePanel } from "@/components/CreatePanel";
import { createPanel, useCreatePanelOpen } from "@/lib/create-panel";


const SIDEBAR_COOKIE_NAME = "sidebar_state";

// Account switching (#191): the other sessions signed in on this browser
// (Better Auth multiSession). Rendered inside the account dropdown — pick one
// to switch without re-authenticating, or add another account via /sign-in.
function AccountSwitcherItems({ currentEmail }: { currentEmail: string | null | undefined }) {
  const [accounts, setAccounts] = useState<{ token: string; email: string; name: string | null }[]>([]);

  useEffect(() => {
    let cancelled = false;
    authClient.multiSession
      .listDeviceSessions()
      .then((res) => {
        const list = (res?.data ?? []) as Array<{ session: { token: string }; user: { email: string; name?: string | null } }>;
        if (!cancelled) {
          setAccounts(list.map((d) => ({ token: d.session.token, email: d.user.email, name: d.user.name ?? null })));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const others = accounts.filter((a) => a.email !== currentEmail);

  async function switchTo(token: string) {
    await authClient.multiSession.setActive({ sessionToken: token });
    // The new account's org memberships differ — drop the sticky client org and
    // let the server pick its last-active/earliest org. Full reload so every
    // query and context resets.
    try {
      localStorage.removeItem("tv.activeOrgId");
    } catch {
      /* ignore */
    }
    window.location.assign("/dashboard");
  }

  return (
    <>
      {others.map((account) => (
        <DropdownMenuItem
          key={account.token}
          className="gap-2 cursor-pointer"
          onSelect={() => void switchTo(account.token)}
          data-testid={`switch-account-${account.email}`}
        >
          <div className="h-5 w-5 rounded-full bg-primary/20 flex items-center justify-center text-[10px] font-medium text-primary shrink-0">
            {(account.name?.[0] ?? account.email[0] ?? "?").toUpperCase()}
          </div>
          <span className="min-w-0 flex-1 truncate">{account.name ?? account.email}</span>
        </DropdownMenuItem>
      ))}
      <DropdownMenuItem asChild>
        <Link href="/sign-in" className="flex items-center gap-2 cursor-pointer" data-testid="add-account-link">
          <UserPlus className="h-4 w-4" />
          Add account
        </Link>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/albums", label: "Albums", icon: Images },
  { href: "/photos", label: "Photos", icon: Grid2x2 },
  { href: "/collections", label: "Collections", icon: FolderOpen },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/smart-collections", label: "Smart", icon: Sparkles },
  { href: "/people", label: "People", icon: Users },
  { href: "/assets", label: "Assets", icon: Palette },
  { href: "/create", label: "Create", icon: Wand2 },
];

// Drag type for reordering the top-level nav; distinct from PHOTO_DND_MIME so
// nav reordering and photo-onto-collection drags never interfere.
const NAV_DND_MIME = "application/x-vispix-nav";

// Apply the user's saved order (array of hrefs) to navItems. Hrefs that no
// longer exist are dropped; nav items missing from the saved order (added
// after the user saved) keep their default relative position at the end.
function applyNavOrder(order: string[] | null | undefined) {
  if (!order || order.length === 0) return navItems;
  const byHref = new Map(navItems.map((i) => [i.href, i]));
  const ordered = order
    .map((h) => byHref.get(h))
    .filter((i): i is (typeof navItems)[number] => i !== undefined);
  const seen = new Set(order);
  return [...ordered, ...navItems.filter((i) => !seen.has(i.href))];
}

// Reads the persisted sidebar open/collapsed state (written as a cookie by
// SidebarProvider) so the choice survives reloads without a flash of the
// wrong state on first paint.
function getInitialSidebarOpen(): boolean {
  if (typeof document === "undefined") return true;
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${SIDEBAR_COOKIE_NAME}=(true|false)`)
  );
  return match ? match[1] === "true" : true;
}

function humanSpeed(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

function useBannerVisible() {
  const [location] = useLocation();
  const ctx = useBulkUploadOptional();
  const photoCtx = usePhotoUploadOptional();
  const bulk = !!(ctx && (ctx.phase === "uploading" || ctx.phase === "complete") && location !== "/bulk-upload");
  const photo = !!(photoCtx && photoCtx.phase !== "idle");
  return bulk || photo;
}

function BulkUploadBanner() {
  const [location] = useLocation();
  const ctx = useBulkUploadOptional();

  if (!ctx || location === "/bulk-upload") return null;
  if (ctx.phase !== "uploading" && ctx.phase !== "complete") return null;

  const { totalFiles, completedFiles, overallProgress, isPaused, speedBps, togglePause, phase, queueFiles, resetQueue } = ctx;

  if (phase === "complete") {
    const totalDone = queueFiles.filter((f) => f.status === "done").length;
    const totalFailed = queueFiles.filter((f) => f.status === "error").length;
    return (
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border shadow-lg">
        <div className="px-4 sm:px-6 lg:px-8 py-3 flex items-center gap-4">
          <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium text-foreground">Upload complete — </span>
            <span className="text-sm text-muted-foreground">
              {totalDone} photo{totalDone !== 1 ? "s" : ""} uploaded
              {totalFailed > 0 && `, ${totalFailed} failed`}
            </span>
          </div>
          <Link
            href="/bulk-upload"
            className="text-xs text-primary font-medium whitespace-nowrap shrink-0 hover:text-primary/80"
          >
            View results →
          </Link>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 shrink-0"
            onClick={resetQueue}
            title="Dismiss"
            data-testid="dismiss-upload-banner"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border shadow-lg">
      <div className="px-4 sm:px-6 lg:px-8 py-3 flex items-center gap-4">
        <Upload className="h-4 w-4 text-primary shrink-0" />
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Uploading photos…</span>
            <span>
              {completedFiles} / {totalFiles}
              {speedBps > 0 && <span className="ml-2">{humanSpeed(speedBps)}</span>}
            </span>
          </div>
          <Progress value={overallProgress} className="h-1.5" />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={(e) => { e.stopPropagation(); togglePause(); }}
            title={isPaused ? "Resume" : "Pause"}
          >
            {isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </Button>
          <Link
            href="/bulk-upload"
            className="text-xs text-primary hover:text-primary/80 font-medium whitespace-nowrap"
          >
            View progress
          </Link>
        </div>
      </div>
    </div>
  );
}

function GlobalSearchBar() {
  const [, setLocation] = useLocation();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const q = value.trim();
    if (!q) return;
    setLocation(`/search?q=${encodeURIComponent(q)}`);
    setValue("");
    inputRef.current?.blur();
  }

  return (
    <form onSubmit={handleSubmit} className="relative flex-1 max-w-md" data-testid="global-search-form">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search photos..."
        className="h-8 pl-8 pr-3 text-sm w-full bg-muted/50 border-transparent focus:bg-background focus:border-input"
        data-testid="global-search-input"
      />
    </form>
  );
}

function ThemeMenuButton() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  return (
    <SidebarMenuButton
      onClick={toggleTheme}
      tooltip={isDark ? "Switch to light mode" : "Switch to dark mode"}
      data-testid="theme-toggle"
    >
      {isDark ? <Sun /> : <Moon />}
      <span>{isDark ? "Light mode" : "Dark mode"}</span>
    </SidebarMenuButton>
  );
}

const PROJECTS_NAV_OPEN_KEY = "projects_nav_open";

// The "Projects" nav entry as a collapsible tree: the label links to /projects,
// a chevron expands to list each project (with its photo count), and each
// project row is a drop target — drag a photo from any grid onto it to add it.
function ProjectsNav({ location, dragProps }: { location: string; dragProps?: React.LiHTMLAttributes<HTMLLIElement> }) {
  const { data: projects } = useListProjects();
  const { mutate: addToProject } = useAddPhotoToProject();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState<boolean>(() =>
    typeof localStorage !== "undefined" && localStorage.getItem(PROJECTS_NAV_OPEN_KEY) === "true"
  );
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [justAddedId, setJustAddedId] = useState<number | null>(null);

  // While any photo is being dragged, auto-reveal the projects (so they're
  // droppable) and light up the drop zone. Cleared when the drag ends.
  useEffect(() => {
    function onDragStartWin(ev: globalThis.DragEvent) {
      if (ev.dataTransfer?.types.includes(PHOTO_DND_MIME)) {
        setDragActive(true);
        setOpen(true);
      }
    }
    function onDragEndWin() {
      setDragActive(false);
      setDragOverId(null);
    }
    window.addEventListener("dragstart", onDragStartWin);
    window.addEventListener("dragend", onDragEndWin);
    return () => {
      window.removeEventListener("dragstart", onDragStartWin);
      window.removeEventListener("dragend", onDragEndWin);
    };
  }, []);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    try {
      localStorage.setItem(PROJECTS_NAV_OPEN_KEY, String(next));
    } catch {
      // localStorage unavailable (private mode) — expansion just won't persist.
    }
  }

  function handleDrop(e: DragEvent, projectId: number, projectName: string) {
    e.preventDefault();
    setDragOverId(null);
    const photoId = getDraggedPhotoId(e);
    if (photoId == null) return;
    addToProject(
      { id: projectId, data: { photoId } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          qc.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
          qc.invalidateQueries({ queryKey: getGetPhotoQueryKey(photoId) });
          setJustAddedId(projectId);
          window.setTimeout(
            () => setJustAddedId((cur) => (cur === projectId ? null : cur)),
            1100,
          );
          toast({ title: `Added to "${projectName}"` });
        },
        onError: () => toast({ title: "Failed to add to project", variant: "destructive" }),
      }
    );
  }

  return (
    <Collapsible asChild open={open} onOpenChange={handleOpenChange} className="group/projects">
      <SidebarMenuItem {...dragProps}>
        <SidebarMenuButton asChild isActive={location === "/projects"} tooltip="Projects">
          <Link href="/projects" data-testid="nav-projects">
            <FolderKanban />
            <span>Projects</span>
          </Link>
        </SidebarMenuButton>
        {projects && projects.length > 0 && (
          <>
            <CollapsibleTrigger asChild>
              <SidebarMenuAction
                className="transition-transform data-[state=open]:rotate-90"
                data-testid="projects-nav-toggle"
                aria-label={open ? "Collapse projects" : "Expand projects"}
              >
                <ChevronRight />
              </SidebarMenuAction>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarMenuSub data-testid="projects-nav-sub">
                {projects.map((project) => (
                  <SidebarMenuSubItem key={project.id}>
                    <SidebarMenuSubButton
                      asChild
                      isActive={location === `/projects/${project.id}`}
                      className={cn(
                        "origin-left transition-all duration-150",
                        dragActive && "border border-dashed border-primary/50",
                        dragOverId === project.id &&
                          "scale-[1.05] border-solid border-primary bg-primary/15 shadow-lg ring-2 ring-primary",
                        justAddedId === project.id &&
                          "border-solid border-emerald-500 bg-emerald-500/15 ring-2 ring-emerald-500",
                      )}
                      onDragOver={(e: DragEvent) => {
                        if (isPhotoDrag(e)) {
                          e.preventDefault();
                          setDragOverId(project.id);
                        }
                      }}
                      onDragLeave={() => setDragOverId((cur) => (cur === project.id ? null : cur))}
                      onDrop={(e: DragEvent) => handleDrop(e, project.id, project.name)}
                    >
                      <Link href={`/projects/${project.id}`} data-testid={`projects-nav-item-${project.id}`}>
                        <span className="truncate">{project.name}</span>
                        <SidebarMenuBadge
                          className={cn(
                            "transition-transform duration-200",
                            justAddedId === project.id && "scale-150 text-emerald-400",
                          )}
                        >
                          {project.photoCount}
                        </SidebarMenuBadge>
                      </Link>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ))}
              </SidebarMenuSub>
            </CollapsibleContent>
          </>
        )}
      </SidebarMenuItem>
    </Collapsible>
  );
}

const COLLECTIONS_NAV_OPEN_KEY = "collections_nav_open";

// The "Collections" nav entry as a collapsible tree, mirroring ProjectsNav: the
// label links to /collections, a chevron expands to list each collection (with
// its photo count), and each row is a drop target — drag a photo from any grid
// onto it to add it to that collection.
function CollectionsNav({ location, dragProps }: { location: string; dragProps?: React.LiHTMLAttributes<HTMLLIElement> }) {
  const { data: collections } = useListCollections();
  const { mutate: addToCollection } = useAddPhotoToCollection();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState<boolean>(() =>
    typeof localStorage !== "undefined" && localStorage.getItem(COLLECTIONS_NAV_OPEN_KEY) === "true"
  );
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [justAddedId, setJustAddedId] = useState<number | null>(null);

  // While any photo is being dragged, auto-reveal the collections (so they're
  // droppable) and light up the drop zone. Cleared when the drag ends.
  useEffect(() => {
    function onDragStartWin(ev: globalThis.DragEvent) {
      if (ev.dataTransfer?.types.includes(PHOTO_DND_MIME)) {
        setDragActive(true);
        setOpen(true);
      }
    }
    function onDragEndWin() {
      setDragActive(false);
      setDragOverId(null);
    }
    window.addEventListener("dragstart", onDragStartWin);
    window.addEventListener("dragend", onDragEndWin);
    return () => {
      window.removeEventListener("dragstart", onDragStartWin);
      window.removeEventListener("dragend", onDragEndWin);
    };
  }, []);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    try {
      localStorage.setItem(COLLECTIONS_NAV_OPEN_KEY, String(next));
    } catch {
      // localStorage unavailable (private mode) — expansion just won't persist.
    }
  }

  function handleDrop(e: DragEvent, collectionId: number, collectionTitle: string) {
    e.preventDefault();
    setDragOverId(null);
    const photoId = getDraggedPhotoId(e);
    if (photoId == null) return;
    addToCollection(
      { id: collectionId, data: { photoId } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListCollectionsQueryKey() });
          qc.invalidateQueries({ queryKey: getGetCollectionQueryKey(collectionId) });
          qc.invalidateQueries({ queryKey: getGetPhotoQueryKey(photoId) });
          setJustAddedId(collectionId);
          window.setTimeout(
            () => setJustAddedId((cur) => (cur === collectionId ? null : cur)),
            1100,
          );
          toast({ title: `Added to "${collectionTitle}"` });
        },
        onError: () => toast({ title: "Failed to add to collection", variant: "destructive" }),
      }
    );
  }

  return (
    <Collapsible asChild open={open} onOpenChange={handleOpenChange} className="group/collections">
      <SidebarMenuItem {...dragProps}>
        <SidebarMenuButton asChild isActive={location === "/collections"} tooltip="Collections">
          <Link href="/collections" data-testid="nav-collections">
            <FolderOpen />
            <span>Collections</span>
          </Link>
        </SidebarMenuButton>
        {collections && collections.length > 0 && (
          <>
            <CollapsibleTrigger asChild>
              <SidebarMenuAction
                className="transition-transform data-[state=open]:rotate-90"
                data-testid="collections-nav-toggle"
                aria-label={open ? "Collapse collections" : "Expand collections"}
              >
                <ChevronRight />
              </SidebarMenuAction>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarMenuSub data-testid="collections-nav-sub">
                {collections.map((collection) => (
                  <SidebarMenuSubItem key={collection.id}>
                    <SidebarMenuSubButton
                      asChild
                      isActive={location === `/collections/${collection.id}`}
                      className={cn(
                        "origin-left transition-all duration-150",
                        dragActive && "border border-dashed border-primary/50",
                        dragOverId === collection.id &&
                          "scale-[1.05] border-solid border-primary bg-primary/15 shadow-lg ring-2 ring-primary",
                        justAddedId === collection.id &&
                          "border-solid border-emerald-500 bg-emerald-500/15 ring-2 ring-emerald-500",
                      )}
                      onDragOver={(e: DragEvent) => {
                        if (isPhotoDrag(e)) {
                          e.preventDefault();
                          setDragOverId(collection.id);
                        }
                      }}
                      onDragLeave={() => setDragOverId((cur) => (cur === collection.id ? null : cur))}
                      onDrop={(e: DragEvent) => handleDrop(e, collection.id, collection.title)}
                    >
                      <Link href={`/collections/${collection.id}`} data-testid={`collections-nav-item-${collection.id}`}>
                        <span className="truncate">{collection.title}</span>
                        <SidebarMenuBadge
                          className={cn(
                            "transition-transform duration-200",
                            justAddedId === collection.id && "scale-150 text-emerald-400",
                          )}
                        >
                          {collection.photoCount}
                        </SidebarMenuBadge>
                      </Link>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ))}
              </SidebarMenuSub>
            </CollapsibleContent>
          </>
        )}
      </SidebarMenuItem>
    </Collapsible>
  );
}

// Org switcher (issue #113): shows the active organization and lets the user
// switch between the orgs they belong to. Hidden entirely when the user has a
// single org (nothing to switch), so single-tenant deployments see no change.
function OrgSwitcher() {
  const { orgs, activeOrg, switchOrg } = useOrg();
  const isMobile = useIsMobile();
  if (orgs.length <= 1) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton tooltip={activeOrg?.name ?? "Organization"} data-testid="org-switcher">
              {activeOrg?.logoUrl ? (
                <img src={activeOrg.logoUrl} alt="" className="size-4 shrink-0 rounded-sm object-cover" />
              ) : (
                <Building2 />
              )}
              <div className="grid flex-1 text-left leading-tight min-w-0">
                <span className="truncate font-medium">{activeOrg?.name ?? "Select organization"}</span>
                {activeOrg?.role && <span className="truncate text-xs text-muted-foreground">{activeOrg.role}</span>}
              </div>
              <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side={isMobile ? "bottom" : "right"} align="start" className="w-56">
            <div className="px-2 py-1.5 text-xs text-muted-foreground">Organizations</div>
            <DropdownMenuSeparator />
            {orgs.map((o) => (
              <DropdownMenuItem
                key={o.id}
                onSelect={() => switchOrg(o.id)}
                className="cursor-pointer gap-2"
                data-testid={`org-option-${o.id}`}
              >
                <Check className={cn("h-4 w-4 shrink-0", o.id === activeOrg?.id ? "opacity-100" : "opacity-0")} />
                {o.logoUrl ? (
                  <img src={o.logoUrl} alt="" className="h-4 w-4 shrink-0 rounded-sm object-cover" />
                ) : (
                  <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate flex-1">{o.name}</span>
                <span className="text-xs text-muted-foreground">{o.role}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function AppSidebar({
  location,
  isAdmin,
  isPlatformAdmin,
}: {
  location: string;
  isAdmin: boolean;
  isPlatformAdmin: boolean;
}) {
  const { data: session } = useSession();
  const user = session?.user;
  const firstName = user?.name?.split(" ")[0];
  const { data: me } = useGetMe();
  const isMobile = useIsMobile();
  const createPanelOpen = useCreatePanelOpen();
  const qc = useQueryClient();
  const { mutate: saveNavOrder } = useUpdateNavOrder();

  // Drag-to-reorder for the top-level nav. localNavOrder holds the live order
  // during/after a drag (optimistic); the server copy arrives via me.navOrder.
  const [draggingNav, setDraggingNav] = useState<string | null>(null);
  const [localNavOrder, setLocalNavOrder] = useState<string[] | null>(null);

  const orderedNav = applyNavOrder(localNavOrder ?? me?.navOrder);
  // Admin + Superadmin now live in the account menu (footer dropdown, below),
  // so the main nav is just the user-orderable content items.
  const items: { href: string; to?: string; label: string; icon: LucideIcon; iconClass?: string }[] = orderedNav;

  function navDragProps(href: string): React.LiHTMLAttributes<HTMLLIElement> {
    return {
      draggable: true,
      title: "Drag to reorder",
      className: cn(draggingNav === href && "opacity-50"),
      onDragStart: (e) => {
        e.dataTransfer.setData(NAV_DND_MIME, href);
        e.dataTransfer.effectAllowed = "move";
        setDraggingNav(href);
      },
      onDragOver: (e) => {
        if (!draggingNav || draggingNav === href) return;
        e.preventDefault();
        // Live-reorder while hovering: move the dragged item to this slot.
        setLocalNavOrder((cur) => {
          const order = cur ?? applyNavOrder(me?.navOrder).map((i) => i.href);
          const from = order.indexOf(draggingNav);
          const to = order.indexOf(href);
          if (from === -1 || to === -1 || from === to) return cur;
          const next = [...order];
          next.splice(from, 1);
          next.splice(to, 0, draggingNav);
          return next;
        });
      },
      onDrop: (e) => e.preventDefault(),
      onDragEnd: () => {
        setDraggingNav(null);
        setLocalNavOrder((cur) => {
          if (cur) {
            saveNavOrder(
              { data: { navOrder: cur } },
              { onSuccess: () => qc.invalidateQueries({ queryKey: getGetMeQueryKey() }) },
            );
          }
          return cur;
        });
      },
    };
  }

  return (
    <Sidebar collapsible="icon" data-testid="app-sidebar">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="Vispix">
              <Link href={isPlatformAdmin ? "/superadmin" : "/dashboard"} data-testid="sidebar-brand">
                <img src="/vispix.png" alt="Vispix" className="size-6 shrink-0 rounded" />
                <span className="font-semibold tracking-tight">Vispix</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <OrgSwitcher />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarMenu data-testid="main-nav">
            {items.map((item) => {
              const dragProps = navDragProps(item.href);
              if (item.href === "/collections") {
                return <CollectionsNav key={item.href} location={location} dragProps={dragProps} />;
              }
              if (item.href === "/projects") {
                return <ProjectsNav key={item.href} location={location} dragProps={dragProps} />;
              }
              // Create (#167 UX): on desktop the nav item toggles the right
              // slide-out panel so the app stays visible; mobile keeps the page.
              if (item.href === "/create" && !isMobile) {
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.href} {...dragProps}>
                    <SidebarMenuButton
                      isActive={createPanelOpen}
                      tooltip={item.label}
                      onClick={() => createPanel.toggle()}
                      data-testid="nav-create"
                    >
                      <Icon className={item.iconClass} />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              }
              const Icon = item.icon;
              const active = location === item.href || location.startsWith(item.href + "/");
              return (
                <SidebarMenuItem key={item.href} {...dragProps}>
                  <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                    <Link href={item.to ?? item.href} data-testid={`nav-${item.label.toLowerCase()}`}>
                      <Icon className={item.iconClass} />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <ThemeMenuButton />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  tooltip={firstName ?? user?.email ?? "Account"}
                  data-testid="user-menu-trigger"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <div className="h-6 w-6 rounded-full bg-primary/20 flex items-center justify-center text-xs font-medium text-primary shrink-0">
                    {firstName?.[0] ?? user?.email?.[0]?.toUpperCase() ?? "?"}
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight min-w-0">
                    <span className="truncate font-medium text-foreground">{firstName ?? user?.email ?? "Me"}</span>
                    {user?.email && <span className="truncate text-xs text-muted-foreground">{user.email}</span>}
                  </div>
                  <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side={isMobile ? "bottom" : "right"} align="end" className="w-52">
                <div className="px-3 py-2">
                  <p className="text-sm font-medium text-foreground truncate">{user?.name ?? "Team Member"}</p>
                  <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
                  {me?.role && (
                    <span className={cn(
                      "mt-1 inline-block text-xs px-1.5 py-0.5 rounded font-medium",
                      me.role === "admin" ? "bg-primary/10 text-primary" : "bg-secondary text-secondary-foreground"
                    )}>
                      {me.role}
                    </span>
                  )}
                </div>
                <DropdownMenuSeparator />
                {/* Admin (org owners/admins + platform admins) and Superadmin
                    (platform admins only) live here above Settings. ?org=1 keeps
                    a platform admin on the org /admin panel instead of the
                    /admin → /superadmin default redirect. */}
                {isAdmin && (
                  <DropdownMenuItem asChild>
                    <Link
                      href={isPlatformAdmin ? "/admin?org=1" : "/admin"}
                      className="flex items-center gap-2 cursor-pointer"
                      data-testid="nav-admin"
                    >
                      <Shield className="h-4 w-4" />
                      Admin
                    </Link>
                  </DropdownMenuItem>
                )}
                {isPlatformAdmin && (
                  <DropdownMenuItem asChild>
                    <Link
                      href="/superadmin"
                      className="flex items-center gap-2 cursor-pointer"
                      data-testid="nav-superadmin"
                    >
                      <Shield className="h-4 w-4 text-amber-500" />
                      Superadmin
                    </Link>
                  </DropdownMenuItem>
                )}
                {isAdmin && <DropdownMenuSeparator />}
                <DropdownMenuItem asChild>
                  <Link href="/settings" className="flex items-center gap-2 cursor-pointer" data-testid="settings-link">
                    <Settings className="h-4 w-4" />
                    Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <AccountSwitcherItems currentEmail={user?.email} />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive gap-2 cursor-pointer"
                  onSelect={async () => {
                    await signOut();
                    // Full-page navigation so all client auth/query state resets.
                    window.location.assign("/");
                  }}
                  data-testid="sign-out-btn"
                >
                  <LogOut className="h-4 w-4" />
                  Sign Out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: me } = useGetMe();
  const { activeOrg } = useOrg();
  const bannerVisible = useBannerVisible();
  // Admin = the active org's own owners/admins (plus platform admins);
  // Superadmin = platform admins only (issue #120).
  const isPlatformAdmin = me?.role === "admin";
  const isAdmin =
    isPlatformAdmin || activeOrg?.role === "owner" || activeOrg?.role === "admin";

  return (
    <SidebarProvider defaultOpen={getInitialSidebarOpen()} data-testid="app-layout">
      <AppSidebar location={location} isAdmin={isAdmin} isPlatformAdmin={isPlatformAdmin} />

      <SidebarInset className="min-h-svh">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 sm:gap-3 border-b border-border bg-background/95 px-4 backdrop-blur-sm">
          <SidebarTrigger className="-ml-1" data-testid="sidebar-toggle" />
          <Link href={isPlatformAdmin ? "/superadmin" : "/dashboard"} className="flex items-center gap-2 shrink-0 md:hidden" aria-label="Vispix">
            <img src="/vispix.png" alt="Vispix" className="h-7 w-7 rounded" />
          </Link>
          <GlobalSearchBar />
          <div className="ml-auto">
            <DevEnvironmentBadge />
          </div>
        </header>

        <main className={cn(
          "flex-1 w-full px-4 sm:px-6 lg:px-8 py-6 sm:py-8",
          bannerVisible && "pb-20"
        )}>
          {children}
        </main>

        {!bannerVisible && (
          <footer className="hidden sm:block border-t border-border py-6 text-sm text-muted-foreground">
            <div className="px-4 sm:px-6 lg:px-8">
              <span>© {new Date().getFullYear()} Vispix</span>
            </div>
          </footer>
        )}
      </SidebarInset>

      <BulkUploadBanner />
      <PhotoUploadBanner />
      {/* Desktop Create slide-out — global so it survives page navigation. */}
      <CreatePanel />
    </SidebarProvider>
  );
}
