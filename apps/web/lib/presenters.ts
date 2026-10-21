import { presenterInputSchema, presenterStatus, presenterUpdateSchema, type PresenterInput } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import type { z } from "zod";

/**
 * Presenter kits (ADR 0056): the real stills a workspace's composed AI takes
 * are made from. Only the workspace's own uploads may be a kit's photos:
 * never the shared starter library, never a generated take.
 */

export type PublicPresenter = {
  id: string; name: string; portraitAssetId: string; fullBodyAssetId: string; voice: string | null; isDefault: boolean;
  ready: boolean; status: string; canRetry: boolean; faceHeightPx: number | null; createdAt: string;
};

type Row = Awaited<ReturnType<typeof prisma.presenter.findFirstOrThrow>>;
function toPublic(row: Row): PublicPresenter {
  const status = presenterStatus(row);
  return { id: row.id, name: row.name, portraitAssetId: row.portraitAssetId, fullBodyAssetId: row.fullBodyAssetId, voice: row.voice,
    isDefault: row.isDefault, ready: status.ready, status: status.label, canRetry: Boolean(status.canRetry), faceHeightPx: row.faceHeightPx, createdAt: row.createdAt.toISOString() };
}

export class PresenterError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** An owned JPEG or PNG upload of this workspace. */
async function ownedStill(workspaceId: string, assetId: string, what: string) {
  const asset = await prisma.mediaAsset.findFirst({ where: { id: assetId, workspaceId, shared: false, kind: "IMAGE", contentType: { in: ["image/jpeg", "image/png"] } }, select: { id: true, sizeBytes: true, height: true } });
  if (!asset || assetId.startsWith("ai-")) throw new PresenterError(`Choose a JPEG or PNG photo you uploaded for the ${what}.`);
  if (asset.sizeBytes > 20 * 1024 * 1024) throw new PresenterError(`The ${what} must be under 20 MB.`);
  return asset;
}

export async function listPresenters(workspaceId: string): Promise<PublicPresenter[]> {
  const rows = await prisma.presenter.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } });
  return rows.map(toPublic);
}

export async function createPresenter(workspaceId: string, raw: unknown): Promise<PublicPresenter> {
  const parsed = presenterInputSchema.safeParse(raw);
  if (!parsed.success) throw new PresenterError("Name the presenter and choose a portrait and a full-length photo.");
  const input: PresenterInput = parsed.data;
  await ownedStill(workspaceId, input.portraitAssetId, "portrait");
  await ownedStill(workspaceId, input.fullBodyAssetId, "full-length photo");
  if (await prisma.presenter.count({ where: { workspaceId } }) >= 10) throw new PresenterError("A workspace can keep up to 10 presenters.", 409);
  return prisma.$transaction(async tx => {
    // The first kit is the default; asking for default moves it here.
    const makeDefault = input.isDefault ?? !(await tx.presenter.findFirst({ where: { workspaceId, isDefault: true }, select: { id: true } }));
    if (makeDefault) await tx.presenter.updateMany({ where: { workspaceId, isDefault: true }, data: { isDefault: false } });
    return toPublic(await tx.presenter.create({ data: {
      workspaceId, name: input.name, portraitAssetId: input.portraitAssetId, fullBodyAssetId: input.fullBodyAssetId,
      voice: input.voice ?? null, isDefault: makeDefault,
    } }));
  });
}

export async function updatePresenter(workspaceId: string, id: string, raw: unknown): Promise<PublicPresenter> {
  const parsed = presenterUpdateSchema.safeParse(raw);
  if (!parsed.success) throw new PresenterError("Nothing to change.");
  const update: z.infer<typeof presenterUpdateSchema> = parsed.data;
  const existing = await prisma.presenter.findFirst({ where: { id, workspaceId } });
  if (!existing) throw new PresenterError("That presenter is not in your workspace.", 404);
  if (update.portraitAssetId) await ownedStill(workspaceId, update.portraitAssetId, "portrait");
  if (update.fullBodyAssetId) await ownedStill(workspaceId, update.fullBodyAssetId, "full-length photo");
  // A new portrait needs a new face crop, and so does a retry of one that gave up. Clearing the claim
  // token means a worker still cutting the old portrait cannot publish its crop (it checks the token).
  const newPortrait = update.portraitAssetId && update.portraitAssetId !== existing.portraitAssetId;
  const retry = update.retry && !existing.faceCropKey;
  return prisma.$transaction(async tx => {
    if (update.isDefault) await tx.presenter.updateMany({ where: { workspaceId, isDefault: true, id: { not: id } }, data: { isDefault: false } });
    return toPublic(await tx.presenter.update({ where: { id }, data: {
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.portraitAssetId ? { portraitAssetId: update.portraitAssetId } : {}),
      ...(update.fullBodyAssetId ? { fullBodyAssetId: update.fullBodyAssetId } : {}),
      ...(update.voice !== undefined ? { voice: update.voice } : {}),
      ...(update.isDefault !== undefined ? { isDefault: update.isDefault } : {}),
      ...(newPortrait || retry ? { faceCropKey: null, faceHeightPx: null, faceCropError: null, faceCropTries: 0, leaseToken: null, leaseUntil: null } : {}),
    } }));
  });
}
