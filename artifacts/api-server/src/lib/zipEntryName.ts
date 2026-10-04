// Safe, unique zip entry names from user-controlled filenames. Entries are
// always flat (no directories), so naive extractors can't be steered outside
// the target folder, and names never collide with generated entries.

const MAX_NAME = 120;
const MAX_EXT = 10;

/** Entry names the archive itself writes; photo entries may never use them. */
export const RESERVED_ZIP_ENTRIES = ["usage-rights.json"];

/**
 * A single-segment, printable entry name from `name`, or `photo-<id>.<ext>`
 * when nothing usable is left.
 */
export function safeZipEntryName(name: string | null | undefined, photoId: number | string, fallbackExt = "jpg"): string {
  const segments = (name ?? "").split(/[\\/]+/);
  let base = segments[segments.length - 1] ?? "";
  base = base
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[<>:"|?*]/g, "")
    .replace(/\.{2,}/g, ".")
    .trim()
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (!base) return `photo-${photoId}.${fallbackExt}`;
  if (base.length > MAX_NAME) {
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 && base.length - dot <= MAX_EXT + 1 ? base.slice(dot) : "";
    base = base.slice(0, MAX_NAME - ext.length) + ext;
  }
  return base;
}

/**
 * Like safeZipEntryName, but also unique (case-insensitively) within `used`
 * and clear of reserved names. Records the returned name in `used`.
 */
export function uniqueZipEntryName(name: string | null | undefined, photoId: number | string, used: Set<string>): string {
  let entry = safeZipEntryName(name, photoId);
  const taken = (n: string) => used.has(n.toLowerCase()) || RESERVED_ZIP_ENTRIES.includes(n.toLowerCase());
  if (taken(entry)) {
    const dot = entry.lastIndexOf(".");
    const stem = dot > 0 ? entry.slice(0, dot) : entry;
    const ext = dot > 0 ? entry.slice(dot) : "";
    entry = `${stem}-${photoId}${ext}`;
    for (let n = 2; taken(entry); n++) entry = `${stem}-${photoId}-${n}${ext}`;
  }
  used.add(entry.toLowerCase());
  return entry;
}
