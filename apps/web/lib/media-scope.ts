/**
 * Media a workspace may use: its own uploads plus the open starter library,
 * which is imported once and shared by every workspace. Kept free of Next.js
 * imports so the worker can run the AI steps that use it (ADR 0049).
 */
export function mediaScope(workspaceId: string) {
  return { OR: [{ workspaceId }, { shared: true }] };
}
