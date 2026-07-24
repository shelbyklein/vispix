import { Link } from "wouter";
import { Folder, ChevronLeft } from "lucide-react";

// Shared folder drill-down primitives for the Albums and Assets libraries
// (#149/#159 folders, #158 drill-down). Folders are the distinct free-text
// `folder` labels on items; there's no folder table.

export function collectFolders<T extends { folder?: string | null }>(items: T[] | undefined): string[] {
  const set = new Set<string>();
  for (const it of items ?? []) if (it.folder) set.add(it.folder);
  // Newest-label-first, numeric-aware so "2026" sorts above "2025".
  return [...set].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

// A folder tile for the index view. `covers` are up to 4 image URLs shown as a
// 2x2 preview collage; falls back to a folder glyph when empty.
export function FolderCard({ name, count, covers, href }: { name: string; count: number; covers: string[]; href: string }) {
  return (
    <Link href={href}>
      <div
        className="rounded-xl overflow-hidden border border-border bg-card group cursor-pointer hover:shadow-md transition-shadow"
        data-testid={`folder-card-${name}`}
      >
        <div className="aspect-[4/3] bg-muted grid grid-cols-2 grid-rows-2 gap-0.5">
          {covers.length > 0 ? (
            Array.from({ length: 4 }).map((_, i) =>
              covers[i] ? (
                <img key={i} src={covers[i]} alt="" className="h-full w-full object-cover" loading="lazy" />
              ) : (
                <div key={i} className="bg-muted" />
              ),
            )
          ) : (
            <div className="col-span-2 row-span-2 flex items-center justify-center text-muted-foreground/40">
              <Folder className="h-10 w-10" />
            </div>
          )}
        </div>
        <div className="p-3 flex items-center gap-2">
          <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="font-medium text-foreground text-sm truncate flex-1">{name}</span>
          <span className="text-xs text-muted-foreground">{count}</span>
        </div>
      </div>
    </Link>
  );
}

export function FolderBreadcrumb({ rootHref, rootLabel, folder }: { rootHref: string; rootLabel: string; folder: string }) {
  return (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="folder-breadcrumb">
      <Link href={rootHref} className="inline-flex items-center gap-1 hover:text-foreground">
        <ChevronLeft className="h-3.5 w-3.5" />
        {rootLabel}
      </Link>
      <span>/</span>
      <span className="inline-flex items-center gap-1 font-medium text-foreground">
        <Folder className="h-3.5 w-3.5" />
        {folder}
      </span>
    </div>
  );
}
