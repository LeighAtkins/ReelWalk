/**
 * What a connected app may do for a person (ADR 0077). Granted one by one on
 * the consent screen, carried by every token, checked again by every tool.
 */
export const SCOPES = ["reels:read", "reels:write", "exports", "ai:generate"] as const;
export type Scope = (typeof SCOPES)[number];

export const SCOPE_LABELS: Record<Scope, { title: string; detail: string }> = {
  "reels:read": { title: "See your reels and media", detail: "List reels and library media, read a reel's cut, and look at frames, checks and the sound of a finished export." },
  "reels:write": { title: "Edit your reels", detail: "Create reels, add stock clips and uploads to your library, and change a reel's cut. Every change is a new revision you can undo in the editor." },
  exports: { title: "Export reels", detail: "Start an export and read its status and download link. Counts against your plan's exports." },
  "ai:generate": { title: "Spend AI credits", detail: "Start AI video shots. Uses your own credits and the same limits as the editor." },
};

/** Granted when an app asks for no scope in particular. AI credits are never granted by default. */
export const DEFAULT_SCOPES: readonly Scope[] = ["reels:read", "reels:write", "exports"];

export const isScope = (value: string): value is Scope => (SCOPES as readonly string[]).includes(value);

/** The scopes in a space-separated `scope` parameter; `unknown` holds the words that are not ours. */
export function parseScopes(value: string | null | undefined): { scopes: Scope[]; unknown: string[] } {
  const words = [...new Set((value ?? "").split(/[\s+]+/).filter(Boolean))];
  return { scopes: words.filter(isScope), unknown: words.filter((word) => !isScope(word)) };
}

export const formatScopes = (scopes: readonly string[]): string => scopes.join(" ");

/** True when every scope in `needed` is in `have`. */
export const hasScopes = (have: readonly string[], needed: readonly Scope[]): boolean => needed.every((scope) => have.includes(scope));
