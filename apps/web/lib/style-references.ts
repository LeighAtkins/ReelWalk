import { describeRecipe, recipeGaps, styleRecipeSchema, type StyleRecipe } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { startWorkerStepRun } from "./workflows";

/**
 * Style references (ADR 0102). The owner downloads a reel (Instagram's own Download, or a screen recording) and shares
 * or uploads it here; it is uploaded like any video, then registered as a reference, which takes it out of the media
 * library (mediaScope) and starts its "reference-read" step in the worker. Nothing is ever fetched from a link: a
 * pasted URL is kept only as a note of where the reel came from.
 */

export const REFERENCE_STATUSES = ["measuring", "reading", "ready", "failed"] as const;
export type ReferenceStatus = (typeof REFERENCE_STATUSES)[number];

/** The step's request id: one reading per reference and version of the reader. */
export const REFERENCE_READ_VERSION = 1;
export const referenceReadRequestId = (referenceId: string) => `reference-read:${referenceId}:v${REFERENCE_READ_VERSION}`;

/** A pasted link, kept only when it is an http(s) URL; trimmed to 500 characters. */
export function cleanSourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString().slice(0, 500);
  } catch {
    return null;
  }
}

export type StyleReferenceView = {
  id: string;
  title: string | null;
  sourceUrl: string | null;
  status: ReferenceStatus;
  error: string | null;
  createdAt: string;
  durationMs: number | null;
  thumbKey: string | null;
  recipe: StyleRecipe | null;
  summary: string | null;
  gaps: ReturnType<typeof recipeGaps>;
};

type Row = {
  id: string; title: string | null; sourceUrl: string | null; status: string; error: string | null; createdAt: Date; recipe: unknown;
  mediaAsset: { durationMs: number | null; thumbKey: string | null };
};
const select = { id: true, title: true, sourceUrl: true, status: true, error: true, createdAt: true, recipe: true, mediaAsset: { select: { durationMs: true, thumbKey: true } } } as const;

export function referenceView(row: Row): StyleReferenceView {
  const recipe = styleRecipeSchema.safeParse(row.recipe).data ?? null;
  const status = (REFERENCE_STATUSES as readonly string[]).includes(row.status) ? (row.status as ReferenceStatus) : "failed";
  return {
    id: row.id, title: row.title, sourceUrl: row.sourceUrl, status, error: row.error, createdAt: row.createdAt.toISOString(),
    durationMs: row.mediaAsset.durationMs, thumbKey: row.mediaAsset.thumbKey,
    recipe, summary: recipe ? describeRecipe(recipe) : null, gaps: recipe ? recipeGaps(recipe) : [],
  };
}

export async function listStyleReferences(workspaceId: string, take = 50): Promise<StyleReferenceView[]> {
  const rows = await prisma.styleReference.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take, select });
  return rows.map(referenceView);
}

export async function getStyleReference(workspaceId: string, id: string): Promise<StyleReferenceView | null> {
  const row = await prisma.styleReference.findFirst({ where: { id, workspaceId }, select });
  return row ? referenceView(row) : null;
}

export type StartReferenceResult =
  | { ok: true; reference: StyleReferenceView; jobId: string; resumed: boolean }
  | { ok: false; status: number; message: string };

/**
 * Registers an uploaded video as a style reference and starts (or resumes) its reading. The same upload again answers
 * with the same reference; a reference whose reading failed is read again, keeping what was already measured.
 */
export async function startStyleReference(input: {
  user: { id: string; workspaceId: string };
  mediaAssetId: string;
  sourceUrl?: unknown;
  title?: unknown;
}): Promise<StartReferenceResult> {
  const { user } = input;
  const asset = await prisma.mediaAsset.findFirst({ where: { id: input.mediaAssetId, workspaceId: user.workspaceId }, select: { id: true, kind: true, durationMs: true } });
  if (!asset) return { ok: false, status: 404, message: "That upload is not in this workspace." };
  if (asset.kind !== "VIDEO") return { ok: false, status: 400, message: "A style reference has to be a video." };
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 120) : null;
  const sourceUrl = cleanSourceUrl(input.sourceUrl);
  const reference = await prisma.styleReference.upsert({
    where: { mediaAssetId: asset.id },
    update: {},
    create: { workspaceId: user.workspaceId, mediaAssetId: asset.id, title, sourceUrl },
    select: { id: true, workspaceId: true, status: true },
  });
  if (reference.workspaceId !== user.workspaceId) return { ok: false, status: 404, message: "That upload is not in this workspace." };
  if (reference.status === "failed") {
    await prisma.styleReference.update({ where: { id: reference.id }, data: { status: "measuring", error: null } });
  }
  const started = await startWorkerStepRun({ user, kind: "reference-read", requestId: referenceReadRequestId(reference.id), payload: { referenceId: reference.id } });
  if (!started.ok) {
    await prisma.styleReference.update({ where: { id: reference.id }, data: { status: "failed", error: started.message.slice(0, 300) } });
    return { ok: false, status: started.status, message: started.message };
  }
  const view = await getStyleReference(user.workspaceId, reference.id);
  return { ok: true, reference: view!, jobId: started.jobId, resumed: started.resumed };
}
