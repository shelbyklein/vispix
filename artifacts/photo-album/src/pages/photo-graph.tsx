import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import ForceGraph3D, { type ForceGraph3DInstance } from "3d-force-graph";
import * as THREE from "three";
import { ArrowLeft, ExternalLink, List, Loader2, Orbit, RotateCw } from "lucide-react";
import { useGetPhotoGraph, getGetPhotoGraphQueryKey, ApiError } from "@workspace/api-client-react";
import type { PhotoGraph, PhotoGraphNode, PhotoGraphThreadKind } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { cn } from "@/lib/utils";

// Photo Graph (#202, phase 2): a 3D view of the threads around one photo.
// Clicking a photo re-centres on it and merges its neighbourhood into the
// view, so the graph grows outward as you explore. The centre photo is in the
// URL (/photos/:id/graph), so it can be shared and Back steps back a photo.

const KINDS: { kind: PhotoGraphThreadKind; label: string; color: string }[] = [
  { kind: "similar", label: "Looks similar", color: "#7dd3fc" },
  { kind: "duplicate", label: "Near duplicate", color: "#c4b5fd" },
  { kind: "person", label: "Same person", color: "#f9a8d4" },
  { kind: "event", label: "Same album", color: "#fcd34d" },
  { kind: "rights", label: "Same usage rights", color: "#86efac" },
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.kind, k])) as Record<PhotoGraphThreadKind, (typeof KINDS)[number]>;
const DEFAULT_ON: PhotoGraphThreadKind[] = ["similar", "duplicate", "person", "event"];
/** Past this many photos the merged view starts over around the current centre. */
const MAX_MERGED = 250;

type GNode = PhotoGraphNode & { x?: number; y?: number; z?: number; fx?: number; fy?: number; fz?: number };
type GLink = { key: string; source: number | GNode; target: number | GNode; kind: PhotoGraphThreadKind; weight: number; label: string };
const endId = (e: number | GNode) => (typeof e === "object" ? e.id : e);

/** Only same-app paths are accepted as the Back target (no open redirects). */
function safeFrom(raw: string | null): string | null {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : null;
}
function backLabel(from: string) {
  return from.startsWith("/search") ? "Back to search" : from.startsWith("/photos/") ? "Back to photo" : "Back";
}
function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** A soft radial glow (the graph's core) drawn once into a texture. */
function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, "rgba(224,242,254,0.95)");
  grad.addColorStop(0.18, "rgba(125,211,252,0.45)");
  grad.addColorStop(0.5, "rgba(56,189,248,0.10)");
  grad.addColorStop(1, "rgba(56,189,248,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}
/** The containment ring around the core, drawn as a camera-facing outline. */
function ringTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  g.strokeStyle = "rgba(255,255,255,0.16)";
  g.lineWidth = 2;
  g.beginPath();
  g.arc(256, 256, 236, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([3, 10]);
  g.strokeStyle = "rgba(255,255,255,0.10)";
  g.beginPath();
  g.arc(256, 256, 252, 0, Math.PI * 2);
  g.stroke();
  return new THREE.CanvasTexture(c);
}

export default function PhotoGraphPage() {
  const { id } = useParams<{ id: string }>();
  const centreId = parseInt(id, 10);
  const search = useSearch();
  const [, navigate] = useLocation();
  const from = safeFrom(new URLSearchParams(search).get("from"));
  const [enabled, setEnabled] = useState<PhotoGraphThreadKind[]>(DEFAULT_ON);
  const [view, setView] = useState<"3d" | "list">(() => (webglAvailable() ? "3d" : "list"));
  const [hoverId, setHoverId] = useState<number | null>(null);
  // The photo the view was (re)started around gets two rings; photos you
  // re-centre on add one ring each.
  const [root, setRoot] = useState(centreId);

  const params = useMemo(
    () => ({ threads: enabled.join(","), depth: centreId === root ? 2 : 1, perThread: 6, limit: 120 }),
    [enabled, centreId, root],
  );
  const query = useGetPhotoGraph(centreId, params, {
    query: { enabled: Number.isInteger(centreId) && centreId > 0, queryKey: getGetPhotoGraphQueryKey(centreId, params), retry: 1, staleTime: 60_000 },
  });

  // The merged graph: persistent node/link objects so the layout keeps its shape as it grows.
  const nodesRef = useRef(new Map<number, GNode>());
  const linksRef = useRef(new Map<string, GLink>());
  const [version, setVersion] = useState(0);
  const [restarted, setRestarted] = useState(false);
  const [glLost, setGlLost] = useState(false);
  const [glKey, setGlKey] = useState(0);
  useEffect(() => {
    // Changing which thread kinds are shown starts over.
    nodesRef.current.clear();
    linksRef.current.clear();
    setVersion((v) => v + 1);
  }, [enabled]);
  useEffect(() => {
    const g: PhotoGraph | undefined = query.data;
    if (!g) return;
    const nodes = nodesRef.current;
    const links = linksRef.current;
    let overflow = false;
    if (nodes.size + g.nodes.length > MAX_MERGED) {
      nodes.clear();
      links.clear();
      overflow = true;
    }
    setRestarted(overflow);
    const anchor = nodes.get(g.seedId);
    for (const n of g.nodes) {
      const existing = nodes.get(n.id);
      if (existing) Object.assign(existing, { ...n, ring: existing.ring });
      else {
        // New photos start next to the photo that reached them, so growth looks like growth.
        const jitter = () => (Math.random() - 0.5) * 30;
        nodes.set(n.id, { ...n, ...(anchor ? { x: (anchor.x ?? 0) + jitter(), y: (anchor.y ?? 0) + jitter(), z: (anchor.z ?? 0) + jitter() } : {}) });
      }
    }
    for (const e of g.edges) {
      const [a, b] = e.source < e.target ? [e.source, e.target] : [e.target, e.source];
      const key = `${a}:${b}:${e.kind}`;
      if (!links.has(key)) links.set(key, { key, source: e.source, target: e.target, kind: e.kind, weight: e.weight, label: e.label });
    }
    setVersion((v) => v + 1);
  }, [query.data]);

  const centre = nodesRef.current.get(centreId) ?? query.data?.nodes.find((n) => n.id === centreId);
  const centreThreads = useMemo(() => {
    const out: { other: GNode; kind: PhotoGraphThreadKind; label: string; weight: number }[] = [];
    for (const l of linksRef.current.values()) {
      const s = endId(l.source), t = endId(l.target);
      if (s !== centreId && t !== centreId) continue;
      const other = nodesRef.current.get(s === centreId ? t : s);
      if (other) out.push({ other, kind: l.kind, label: l.label, weight: l.weight });
    }
    return out.sort((x, y) => KINDS.findIndex((k) => k.kind === x.kind) - KINDS.findIndex((k) => k.kind === y.kind) || y.weight - x.weight);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, centreId]);

  const go = (photoId: number) => navigate(`/photos/${photoId}/graph${from ? `?from=${encodeURIComponent(from)}` : ""}`);
  const toggle = (k: PhotoGraphThreadKind) => {
    setRoot(centreId);
    setEnabled((cur) => (cur.includes(k) ? (cur.length > 1 ? cur.filter((x) => x !== k) : cur) : KINDS.map((x) => x.kind).filter((x) => x === k || cur.includes(x))));
  };

  const err = query.error as unknown;
  const notFound = err instanceof ApiError && err.status === 404;
  const photoCount = nodesRef.current.size;

  return (
    <AppLayout>
      <div
        className="relative -mx-4 -my-6 overflow-hidden bg-[#07090d] text-[#e8ecf2] sm:-mx-6 sm:-my-8 lg:-mx-8"
        style={{ height: "calc(100svh - 3.5rem)" }}
        data-testid="photo-graph"
      >
        {/* Stays mounted in List view (hidden and paused): rebuilding the renderer on
            every switch churns GPU contexts faster than the browser frees them. */}
        {webglAvailable() && !notFound && (
          <GraphCanvas
            hidden={view !== "3d"}
            key={glKey}
            onLost={() => setGlLost(true)}
            onRestored={() => setGlLost(false)}
            nodes={nodesRef.current}
            links={linksRef.current}
            version={version}
            centreId={centreId}
            hoverId={hoverId}
            onHover={setHoverId}
            onSelect={go}
            inset={!!centre}
            label={`3D graph of ${photoCount} photos connected to ${centre?.filename ?? `photo ${centreId}`}. The list view shows the same connections.`}
          />
        )}
        {view === "list" && !notFound && (
          <ListView threads={centreThreads} onSelect={go} loading={query.isLoading} />
        )}

        {/* Top bar */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-3 bg-gradient-to-b from-[#07090d] via-[#07090d]/80 to-transparent p-4 pb-10">
          <div className="pointer-events-auto flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2">
              {from && (
                <Link href={from} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium hover:bg-white/10" data-testid="graph-back">
                  <ArrowLeft className="h-3.5 w-3.5" />
                  {backLabel(from)}
                </Link>
              )}
              {!notFound && <div className="inline-flex rounded-full border border-white/10 bg-white/5 p-0.5 text-xs" role="group" aria-label="View">
                <button type="button" onClick={() => setView("3d")} aria-pressed={view === "3d"} disabled={!webglAvailable()}
                  className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1", view === "3d" ? "bg-white/15" : "opacity-70 hover:opacity-100")} data-testid="graph-view-3d">
                  <Orbit className="h-3.5 w-3.5" /> 3D
                </button>
                <button type="button" onClick={() => setView("list")} aria-pressed={view === "list"}
                  className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1", view === "list" ? "bg-white/15" : "opacity-70 hover:opacity-100")} data-testid="graph-view-list">
                  <List className="h-3.5 w-3.5" /> List
                </button>
              </div>}
            </div>
            {/* Not an <h1>: global heading colours in index.css are !important. */}
            <p role="heading" aria-level={1} className="mt-1 max-w-[min(560px,calc(100vw-2rem))] truncate text-base font-semibold tracking-tight text-[#e8ecf2]" data-testid="graph-title">
              {notFound ? "Photo not available" : `Connections around ${centre?.filename ?? `photo ${centreId}`}`}
            </p>
            {!notFound && <p className="text-xs text-white/55" data-testid="graph-status" aria-live="polite">
              {query.isLoading ? "Mapping connections…" : `${photoCount} photos · ${linksRef.current.size} threads`}
              {query.data?.truncated ? " · more connections exist than shown" : ""}
              {restarted ? " · view restarted around this photo" : ""}
              {query.data?.unavailable.some((u) => u.photoId === centreId) ? " · this photo isn't analysed yet, so no look-alikes" : ""}
            </p>}
          </div>
          {!notFound && <div className="pointer-events-auto -mx-4 flex w-[calc(100%+2rem)] flex-nowrap gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:w-auto sm:max-w-full sm:flex-wrap sm:justify-end sm:overflow-visible sm:px-0 [scrollbar-width:none]" role="group" aria-label="Thread kinds">
            {KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                onClick={() => toggle(k.kind)}
                aria-pressed={enabled.includes(k.kind)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-[rgba(16,20,28,0.86)] px-2.5 py-1.5 text-xs backdrop-blur",
                  !enabled.includes(k.kind) && "opacity-45",
                )}
                data-testid={`graph-kind-${k.kind}`}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: k.color }} />
                {k.label}
              </button>
            ))}
          </div>}
        </div>

        {glLost && view === "3d" && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[#07090d]/90 p-6 text-center" role="alert" data-testid="graph-gl-lost">
            <p className="max-w-sm text-sm text-white/80">The 3D view stopped. Your browser ran short of graphics memory or reset its graphics.</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => { setGlLost(false); setGlKey((k) => k + 1); }} className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-xs font-medium hover:bg-white/25" data-testid="graph-gl-restart">
                <RotateCw className="h-3.5 w-3.5" /> Restart 3D view
              </button>
              <button type="button" onClick={() => { setGlLost(false); setView("list"); }} className="rounded-full border border-white/15 px-3 py-1.5 text-xs hover:bg-white/10">Use list view</button>
            </div>
          </div>
        )}

        {/* Loading / error / not found */}
        {query.isLoading && photoCount === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-white/60" data-testid="graph-loading">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Mapping connections…
          </div>
        )}
        {notFound && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center" data-testid="graph-not-found">
            <p className="text-sm text-white/80">This photo isn't available. It may be in another organization, hidden, or deleted.</p>
            <Link href={from ?? "/photos"} className="rounded-full border border-white/15 px-3 py-1.5 text-xs hover:bg-white/10">Go back</Link>
          </div>
        )}
        {query.isError && !notFound && (
          <div className="absolute inset-x-0 bottom-6 mx-auto flex w-fit items-center gap-3 rounded-full border border-white/10 bg-[rgba(16,20,28,0.92)] px-4 py-2 text-xs" role="alert" data-testid="graph-error">
            Couldn't load connections.
            <button type="button" onClick={() => void query.refetch()} className="inline-flex items-center gap-1 font-medium underline">
              <RotateCw className="h-3.5 w-3.5" /> Retry
            </button>
          </div>
        )}
        {!query.isLoading && !query.isError && query.data && centreThreads.length === 0 && (
          <div className="absolute inset-x-0 bottom-6 mx-auto w-fit rounded-full border border-white/10 bg-[rgba(16,20,28,0.92)] px-4 py-2 text-xs text-white/75" data-testid="graph-empty">
            No connections for this photo with the selected threads.
          </div>
        )}

        {/* The centre photo's card */}
        {centre && view === "3d" && (
          <aside
            className="absolute inset-x-3 bottom-3 max-h-[38%] overflow-hidden rounded-2xl border border-white/10 bg-[rgba(16,20,28,0.9)] backdrop-blur-md sm:inset-x-auto sm:bottom-4 sm:left-4 sm:top-auto sm:w-[340px] sm:max-h-[60%] flex flex-col"
            aria-label="Selected photo"
            data-testid="graph-card"
          >
            <div className="flex gap-3 p-3">
              {centre.thumbnailUrl && (
                <img src={centre.thumbnailUrl} alt={centre.filename ?? "Photo"} className="h-16 w-20 shrink-0 rounded-lg object-cover" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{centre.filename ?? `Photo ${centre.id}`}</p>
                <p className="truncate text-xs text-white/55">
                  {[centre.albumTitle, centre.takenAt ? new Date(centre.takenAt).toLocaleDateString() : null].filter(Boolean).join(" · ")}
                </p>
                <Link href={`/photos/${centre.id}`} className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-sky-300 hover:text-sky-200" data-testid="graph-open-photo">
                  Open photo <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
            </div>
            <ThreadList threads={centreThreads} onSelect={go} onHover={setHoverId} />
          </aside>
        )}
      </div>
    </AppLayout>
  );
}

function ThreadList({
  threads, onSelect, onHover,
}: {
  threads: { other: GNode; kind: PhotoGraphThreadKind; label: string; weight: number }[];
  onSelect: (id: number) => void;
  onHover?: (id: number | null) => void;
}) {
  if (threads.length === 0) return null;
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto border-t border-white/10 px-2 py-2" data-testid="graph-thread-list">
      {threads.map((t) => (
        <li key={`${t.other.id}:${t.kind}`}>
          <button
            type="button"
            onClick={() => onSelect(t.other.id)}
            onMouseEnter={() => onHover?.(t.other.id)}
            onMouseLeave={() => onHover?.(null)}
            onFocus={() => onHover?.(t.other.id)}
            onBlur={() => onHover?.(null)}
            className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left text-xs hover:bg-white/5 focus-visible:bg-white/10 focus-visible:outline-none"
            data-testid="graph-thread"
          >
            {t.other.thumbnailUrl ? (
              <img src={t.other.thumbnailUrl} alt="" className="h-7 w-9 shrink-0 rounded object-cover" loading="lazy" />
            ) : (
              <span className="h-7 w-9 shrink-0 rounded bg-white/10" />
            )}
            <span className="min-w-0 flex-1 truncate">{t.other.filename ?? `Photo ${t.other.id}`}</span>
            <span className="shrink-0 truncate text-[11px]" style={{ color: KIND[t.kind].color, maxWidth: "45%" }}>
              {t.kind === "similar" || t.kind === "duplicate" ? KIND[t.kind].label : `${KIND[t.kind].label} · ${t.label}`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The accessible alternative to the 3D view: the same threads, grouped by kind. */
function ListView({
  threads, onSelect, loading,
}: {
  threads: { other: GNode; kind: PhotoGraphThreadKind; label: string; weight: number }[];
  onSelect: (id: number) => void;
  loading: boolean;
}) {
  return (
    <div className="absolute inset-0 overflow-y-auto px-4 pb-8 pt-44 sm:px-6 sm:pt-36" data-testid="graph-list-view">
      {!loading && threads.length === 0 && <p className="text-sm text-white/60">No connections with the selected threads.</p>}
      {KINDS.map((k) => {
        const items = threads.filter((t) => t.kind === k.kind);
        if (items.length === 0) return null;
        return (
          <section key={k.kind} className="mb-6">
            <p role="heading" aria-level={2} className="mb-2 flex items-center gap-2 text-sm font-semibold text-[#e8ecf2]">
              <span className="h-2 w-2 rounded-full" style={{ background: k.color }} /> {k.label}
            </p>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {items.map((t) => (
                <li key={t.other.id}>
                  <button type="button" onClick={() => onSelect(t.other.id)} className="block w-full overflow-hidden rounded-lg border border-white/10 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">
                    {t.other.thumbnailUrl ? (
                      <img src={t.other.thumbnailUrl} alt="" className="aspect-[4/3] w-full object-cover" loading="lazy" />
                    ) : (
                      <span className="block aspect-[4/3] w-full bg-white/10" />
                    )}
                    <span className="block truncate px-2 pt-1.5 text-xs">{t.other.filename ?? `Photo ${t.other.id}`}</span>
                    <span className="block truncate px-2 pb-1.5 text-[11px] text-white/55">{t.kind === "similar" || t.kind === "duplicate" ? `${Math.round(t.weight * 100)}% match` : t.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function GraphCanvas({
  nodes, links, version, centreId, hoverId, onHover, onSelect, onLost, onRestored, label, inset, hidden,
}: {
  nodes: Map<number, GNode>;
  links: Map<string, GLink>;
  version: number;
  centreId: number;
  hoverId: number | null;
  onHover: (id: number | null) => void;
  onSelect: (id: number) => void;
  /** The browser dropped the WebGL context. */
  onLost: () => void;
  onRestored: () => void;
  label: string;
  /** Leave room for the photo card on wide screens. */
  inset: boolean;
  /** List view is showing: keep the scene but stop drawing. */
  hidden: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const fg = useRef<ForceGraph3DInstance | null>(null);
  const deco = useRef<{ glow: THREE.Sprite; ring: THREE.Sprite } | null>(null);
  const textures = useRef(new Map<number, THREE.Texture>());
  // One material per photo, reused; sprites tracked so sizes can change without rebuilding.
  const materials = useRef(new Map<number, THREE.SpriteMaterial>());
  const sprites = useRef(new Map<number, THREE.Sprite>());
  const state = useRef({ centreId, hoverId, onHover, onSelect, onLost, onRestored });
  state.current = { centreId, hoverId, onHover, onSelect, onLost, onRestored };
  const reduced = prefersReducedMotion();

  const sizeSprite = (obj: THREE.Sprite, id: number) => {
    const n = nodes.get(id);
    const h = id === state.current.centreId ? 22 : (n?.ring ?? 1) >= 2 ? 9 : 13;
    const img = textures.current.get(id)?.image as HTMLImageElement | undefined;
    obj.scale.set(img?.width && img?.height ? h * (img.width / img.height) : h * 1.33, h, 1);
  };

  // Create the scene once.
  useEffect(() => {
    const el = box.current!;
    const loader = new THREE.TextureLoader();
    const sprite = (n: GNode) => {
      let mat = materials.current.get(n.id);
      if (!mat) {
        let tex: THREE.Texture | null = null;
        if (n.thumbnailUrl) {
          tex = loader.load(n.thumbnailUrl, () => {
            const s = sprites.current.get(n.id);
            if (s) sizeSprite(s, n.id);
          });
          tex.colorSpace = THREE.SRGBColorSpace;
          // Thumbnails are small on screen: skip mipmaps (a third less GPU memory each).
          tex.generateMipmaps = false;
          tex.minFilter = THREE.LinearFilter;
          textures.current.set(n.id, tex);
        }
        mat = new THREE.SpriteMaterial({ map: tex, color: tex ? 0xffffff : 0x334155, transparent: true });
        materials.current.set(n.id, mat);
      }
      const obj = new THREE.Sprite(mat);
      sprites.current.set(n.id, obj);
      sizeSprite(obj, n.id);
      return obj;
    };

    const graph = new ForceGraph3D(el, { controlType: "orbit" })
      .backgroundColor("rgba(0,0,0,0)")
      .showNavInfo(false)
      .nodeId("id")
      .nodeLabel(() => "")
      .nodeThreeObject((n) => sprite(n as GNode))
      .linkColor((l) => {
        const L = l as GLink;
        const h = state.current.hoverId ?? state.current.centreId;
        const near = endId(L.source) === h || endId(L.target) === h;
        return rgba(KIND[L.kind].color, near ? 0.9 : 0.22);
      })
      .linkOpacity(1)
      .linkCurvature(0.22)
      .linkResolution(4)
      .linkWidth((l) => {
        // Width follows the centre only: changing it rebuilds every curved thread's geometry.
        const h = state.current.centreId;
        const L = l as GLink;
        // Tubes only for the centre's threads; the rest are 1px lines, which
        // cost a fraction to draw (hundreds of tubes stall weaker GPUs).
        return endId(L.source) === h || endId(L.target) === h ? 1.1 : 0;
      })
      .linkDirectionalParticles((l) => {
        const h = state.current.hoverId;
        const L = l as GLink;
        return !reduced && h != null && (endId(L.source) === h || endId(L.target) === h) ? 2 : 0;
      })
      .linkDirectionalParticleWidth(1.6)
      .linkDirectionalParticleColor((l) => KIND[(l as GLink).kind].color)
      .onNodeHover((n) => {
        el.style.cursor = n ? "pointer" : "grab";
        state.current.onHover(n ? (n as GNode).id : null);
      })
      .onNodeClick((n) => state.current.onSelect((n as GNode).id))
      .cooldownTicks(reduced ? 60 : 160);
    graph.d3Force("charge")?.strength?.(-70);
    (graph.d3Force("link") as unknown as { distance: (fn: (l: GLink) => number) => void })?.distance((l) => 34 + (1 - l.weight) * 70);

    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.scale.set(130, 130, 1);
    const ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), transparent: true, depthWrite: false }));
    ring.scale.set(210, 210, 1);
    graph.scene().add(glow, ring);
    deco.current = { glow, ring };

    const controls = graph.controls() as { autoRotate?: boolean; autoRotateSpeed?: number; enableDamping?: boolean };
    controls.autoRotate = !reduced;
    controls.autoRotateSpeed = 0.35;
    graph.cameraPosition({ x: 0, y: 30, z: 260 });

    // If the browser drops the WebGL context (GPU memory, driver reset), say so
    // and offer a restart instead of leaving a blank canvas.
    const renderer = graph.renderer() as THREE.WebGLRenderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    const canvas = renderer.domElement;
    let tearingDown = false;
    const lost = (e: Event) => {
      e.preventDefault();
      if (!tearingDown) state.current.onLost();
    };
    // The browser often restores the context by itself; clear the message then.
    const restored = () => state.current.onRestored();
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);
    if (import.meta.env.DEV) (window as unknown as { __vispixGraph?: unknown }).__vispixGraph = graph;

    const ro = new ResizeObserver(() => graph.width(el.clientWidth).height(el.clientHeight));
    ro.observe(el);
    fg.current = graph;
    // Keep the glow and ring on the centre photo as the layout settles.
    let raf = 0;
    const follow = () => {
      const c = nodes.get(state.current.centreId);
      if (c && deco.current) {
        deco.current.glow.position.set(c.x ?? 0, c.y ?? 0, c.z ?? 0);
        deco.current.ring.position.set(c.x ?? 0, c.y ?? 0, c.z ?? 0);
      }
      raf = requestAnimationFrame(follow);
    };
    raf = requestAnimationFrame(follow);
    return () => {
      tearingDown = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      for (const m of materials.current.values()) m.dispose();
      for (const t of textures.current.values()) t.dispose();
      materials.current.clear();
      textures.current.clear();
      sprites.current.clear();
      graph._destructor();
      // Release the GPU context now rather than whenever it's garbage-collected
      // (switching 3D/List repeatedly would otherwise pile up contexts).
      const r = graph.renderer() as THREE.WebGLRenderer;
      r.dispose();
      r.forceContextLoss();
      fg.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Feed the merged data; pin the centre photo so the graph grows around it.
  useEffect(() => {
    const graph = fg.current;
    if (!graph) return;
    for (const n of nodes.values()) {
      if (n.id === centreId) {
        n.fx = n.x ?? 0; n.fy = n.y ?? 0; n.fz = n.z ?? 0;
      } else {
        delete n.fx; delete n.fy; delete n.fz;
      }
    }
    // Free photos that left the view (the merged view restarted).
    for (const id of [...materials.current.keys()]) {
      if (nodes.has(id)) continue;
      materials.current.get(id)?.dispose();
      textures.current.get(id)?.dispose();
      materials.current.delete(id);
      textures.current.delete(id);
      sprites.current.delete(id);
    }
    graph.graphData({ nodes: [...nodes.values()], links: [...links.values()] as never });
    // Sizes follow the centre; existing sprites are resized, not rebuilt.
    for (const [id, obj] of sprites.current) sizeSprite(obj, id);
    graph.linkWidth(graph.linkWidth()).linkColor(graph.linkColor());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, centreId]);

  // Swing the camera to the new centre.
  useEffect(() => {
    const graph = fg.current;
    const c = nodes.get(centreId);
    if (!graph || !c) return;
    const p = { x: c.x ?? 0, y: c.y ?? 0, z: c.z ?? 0 };
    const dist = 240;
    const len = Math.hypot(p.x, p.y, p.z) || 1;
    graph.cameraPosition({ x: p.x + (p.x / len) * dist * 0.3, y: p.y + 30, z: p.z + dist }, p, reduced ? 0 : 900);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centreId, version > 0 && nodes.has(centreId)]);

  useEffect(() => {
    const graph = fg.current;
    if (!graph) return;
    if (hidden) graph.pauseAnimation();
    else {
      graph.width(box.current!.clientWidth).height(box.current!.clientHeight);
      graph.resumeAnimation();
    }
  }, [hidden]);

  // Re-evaluate link widths/particles on hover.
  useEffect(() => {
    const graph = fg.current;
    if (!graph) return;
    graph.linkColor(graph.linkColor()).linkDirectionalParticles(graph.linkDirectionalParticles());
  }, [hoverId]);

  return <div ref={box} className={cn("absolute inset-0", inset && "lg:left-[372px] lg:[mask-image:linear-gradient(to_right,transparent,black_72px)]", hidden && "invisible")} aria-hidden={hidden || undefined} role="img" aria-label={label} data-testid="graph-canvas" />;
}
