/**
 * Files picked on the home screen, handed to the editor across a client-side
 * navigation. A File cannot go in a URL or through the server, but the page
 * JavaScript survives router.push, so a module variable is enough.
 */
let pending: { reelId: string; files: File[] } | null = null;

export function setPendingFiles(reelId: string, files: File[]): void {
  pending = { reelId, files };
}

export function takePendingFiles(reelId: string): File[] {
  if (!pending || pending.reelId !== reelId) return [];
  const { files } = pending;
  pending = null;
  return files;
}
