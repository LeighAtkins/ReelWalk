import { BLOCK_SOLVE_VERSION, blockSolveKeyFor, blockStillKeyFor, parseBlockSolve, type BlockSolve } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { mediaScope } from "./media-scope";
import { mediaUrl, readObject } from "./storage";

/**
 * Walk the block (ADR 0093), web side: where a clip's solve is, and what the pin screen needs from it. The worker
 * writes the solve and the still beside nothing else (`blockSolveKeyFor`), so a clip read once is not read again.
 */

export type BlockState =
  | { status: "ready"; assetId: string; solve: BlockSolve; stillUrl: string; /** The clip for the live preview: its 720p rendition when made, else the original. */ videoUrl: string }
  | { status: "refused"; assetId: string; code: string; message: string }
  | { status: "missing"; assetId: string };

export const blockSolveRequestId = (assetId: string) => `block-solve:${assetId}:v${BLOCK_SOLVE_VERSION}`;

/**
 * Whether Walk the block takes new work. Its steps run only in the worker and never call a paid provider, so they need
 * the render queue that exports already use, not AI_JOBS_DURABLE (ADR 0049's switch for moving paid AI steps onto the
 * worker, which is off in production). WALK_BLOCK=off turns it off.
 */
export function walkBlockEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.WALK_BLOCK !== "off";
}

/** A drone clip the workspace may use: its own, or one of the shared library's. */
export function findBlockClip(workspaceId: string, assetId: string) {
  return prisma.mediaAsset.findFirst({ where: { id: assetId, kind: "VIDEO", ...mediaScope(workspaceId) }, select: { id: true, objectKey: true, previewKey: true } });
}

export async function readBlockState(asset: { id: string; objectKey: string; previewKey: string | null }): Promise<BlockState> {
  const object = await readObject(blockSolveKeyFor(asset.id), 2 * 1024 * 1024);
  if (!object) return { status: "missing", assetId: asset.id };
  let value: unknown = null;
  try {
    value = JSON.parse(object.bytes.toString("utf8"));
  } catch {
    // unreadable: parseBlockSolve reports it
  }
  const parsed = parseBlockSolve(value);
  if (!parsed.ok) return { status: "refused", assetId: asset.id, code: parsed.code, message: parsed.message };
  return { status: "ready", assetId: asset.id, solve: parsed.solve, stillUrl: await mediaUrl(blockStillKeyFor(asset.id)), videoUrl: await mediaUrl(asset.previewKey ?? asset.objectKey) };
}
