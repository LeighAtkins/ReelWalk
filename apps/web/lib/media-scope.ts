/**
 * Media a workspace may use: its own uploads plus the open starter library,
 * which is imported once and shared by every workspace. Kept free of Next.js
 * imports so the worker can run the AI steps that use it (ADR 0049).
 *
 * A style reference's video (ADR 0102) is someone else's reel, shared only to be read for its style: it is left out
 * here, so no library, picker, command or export can place it in a reel.
 */
export function mediaScope(workspaceId: string) {
  return { OR: [{ workspaceId }, { shared: true }], styleReference: { is: null } };
}
