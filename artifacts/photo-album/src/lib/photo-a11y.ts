/**
 * Accessible naming for photos. Names come only from facts we hold (filename,
 * ID, album) — never from AI descriptions, which can contain unverified claims
 * about people. Descriptions are used solely as image alt text.
 */

interface PhotoIdentity {
  id: number;
  filename?: string | null;
  name?: string | null;
}

const MAX_ALT_LENGTH = 250;

/** Short identity: the filename, falling back to "Photo <id>". */
export function photoName(photo: PhotoIdentity): string {
  const name = (photo.filename ?? photo.name)?.trim();
  return name ? name : `Photo ${photo.id}`;
}

/**
 * Concise control name, e.g. "Open IMG_0042.jpg, album Regionals". Pass the
 * verb ("Open", "Preview", "Select") and optional safe context (album title,
 * match reason, state like "hidden").
 */
export function photoControlLabel(
  verb: string,
  photo: PhotoIdentity,
  context: { albumTitle?: string | null; extra?: string | null } = {},
): string {
  const parts = [`${verb} ${photoName(photo)}`];
  const album = context.albumTitle?.trim();
  if (album) parts.push(`album ${album}`);
  const extra = context.extra?.trim();
  if (extra) parts.push(extra);
  return parts.join(", ");
}

/**
 * Alt text for a photo image. A description (if any) describes content; with
 * none we return "" so the image is decorative rather than repeating a name
 * that the surrounding control or caption already provides.
 */
export function photoAltText(description?: string | null): string {
  const text = description?.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > MAX_ALT_LENGTH ? `${text.slice(0, MAX_ALT_LENGTH - 1).trimEnd()}…` : text;
}

/** "1,920 x 1,080 px", or null until dimensions have been captured. */
export function formatDimensions(width?: number | null, height?: number | null): string | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  return `${width.toLocaleString("en-US")} × ${height.toLocaleString("en-US")} px`;
}

/** Human file size ("2.4 MB"), or null when unknown. */
export function formatFileSize(bytes?: number | null): string | null {
  if (bytes == null || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}
