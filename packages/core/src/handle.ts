/**
 * An Instagram handle as people type it: with or without the "@", any case,
 * maybe pasted as a profile URL. Returns the bare lowercase name, or null when
 * nothing usable is left. Instagram allows letters, digits, dots and
 * underscores, up to 30 characters.
 */
export function normalizeHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let handle = value.trim();
  const url = handle.match(/^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([^/?#]+)/i);
  if (url) handle = url[1]!;
  handle = handle.replace(/^@+/, "").toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(handle) ? handle : null;
}
