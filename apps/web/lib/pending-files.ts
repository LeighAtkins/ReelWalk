/**
 * Files picked on the home screen, handed to the editor across a client-side
 * navigation. A File cannot go in a URL or through the server, but the page
 * JavaScript survives router.push, so a module variable is enough.
 */
let pending: { reelId: string; files: File[] } | null = null;

/** The room each file was filmed as, from the shot list (ADR 0063); the upload records it on the asset, so the clip knows its room. */
const roomHints = new WeakMap<File, string>();

export function setPendingFiles(reelId: string, files: File[], rooms: (string | null)[] = []): void {
  pending = { reelId, files };
  files.forEach((file, index) => {
    const room = rooms[index];
    if (room) roomHints.set(file, room);
  });
}

export function roomHintFor(file: File): string | null {
  return roomHints.get(file) ?? null;
}

export function takePendingFiles(reelId: string): File[] {
  if (!pending || pending.reelId !== reelId) return [];
  const { files } = pending;
  pending = null;
  return files;
}
