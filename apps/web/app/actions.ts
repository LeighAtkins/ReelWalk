"use server";

import { randomBytes, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  buildReelExportPayload,
  buildTourReel,
  captionForVibe,
  canExport,
  emptyTimeline,
  instagramIssues,
  isEquirect,
  MAX_UPLOAD_BYTES,
  parseTimeline,
  planSchema,
  referencedAssetIds,
  resolveUploadType,
  spotSchema,
  vibeById,
  thumbKeyFor,
  uploadKeyFor,
  type Issue,
  type Timeline,
} from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { toLibraryAsset, type LibraryAsset } from "@/lib/library";
import { flushOutbox, queueRenderJob } from "@/lib/render-jobs";
import { headObject, presignUpload } from "@/lib/storage";
import { getCurrentUser, mediaScope } from "@/lib/workspace";
import { appUrl } from "@/lib/app-url";

// ── Reels ───────────────────────────────────────────────────────

export async function createReel(): Promise<{ id: string }> {
  const user = await getCurrentUser();
  const count = await prisma.reel.count({ where: { workspaceId: user.workspaceId } });
  const reel = await prisma.reel.create({
    data: { workspaceId: user.workspaceId, title: `Reel ${count + 1}`, timeline: emptyTimeline() },
  });
  revalidatePath("/");
  return { id: reel.id };
}

/**
 * Auto-build: a first draft of a walkthrough from a home tour. Rooms in
 * viewing order, sweeps towards the windows, the floor plan, room names, and
 * music with cuts on the beat when the library has a song.
 */
export async function createReelFromTour(input: { tourId: string; vibeId?: string }): Promise<{ id: string } | { error: string }> {
  const user = await getCurrentUser();
  const tour = await prisma.tour.findFirst({ where: { id: input.tourId, workspaceId: user.workspaceId }, include: { media: true } });
  if (!tour) return { error: "That tour no longer exists." };

  const plan = planSchema.safeParse(tour.plan);
  const vibe = vibeById(input.vibeId) ?? null;
  // The vibe's own song when the library has it, otherwise any song with a known tempo.
  const song =
    (vibe
      ? await prisma.mediaAsset.findFirst({ where: { ...mediaScope(user.workspaceId), kind: "AUDIO", objectKey: `library/music/${vibe.song}.mp3` } })
      : null) ??
    (await prisma.mediaAsset.findFirst({
      where: { ...mediaScope(user.workspaceId), kind: "AUDIO", bpm: { not: null } },
      orderBy: { fileName: "asc" },
    }));
  const timeline = buildTourReel({
    shots: tour.media
      .filter((asset) => asset.kind === "IMAGE")
      .map((asset) => {
        const spot = spotSchema.safeParse(asset.spot);
        return {
          assetId: asset.id,
          room: asset.room,
          spot: spot.success ? spot.data : null,
          isPano: isEquirect(asset.width, asset.height),
          passing: spot.success && spot.data.primary === false,
        };
      }),
    plan: plan.success ? plan.data : null,
    music: song ? { assetId: song.id, sourceStartMs: 0, volume: 0.7, bpm: song.bpm, beatOffsetMs: song.beatOffsetMs } : null,
    vibe,
  });
  if (!timeline) return { error: "This tour has too few room photos to build a reel from." };

  const reel = await prisma.reel.create({
    data: {
      workspaceId: user.workspaceId,
      title: (vibe ? `${tour.name}: ${vibe.name}` : tour.name).slice(0, 80),
      caption: vibe ? captionForVibe(vibe, null, song?.attribution) : undefined,
      timeline,
    },
  });
  revalidatePath("/");
  return { id: reel.id };
}

const saveSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().min(0),
  timeline: z.unknown(),
  title: z.string().trim().min(1).max(80).optional(),
});

export type SaveResult = { ok: true; revision: number } | { ok: false; reason: "conflict" | "invalid" | "missing"; message: string };

/**
 * Autosave. The write only happens if the reel is still at the revision the
 * browser last saw; otherwise another tab saved in between and this tab is
 * told to reload rather than overwriting that work.
 */
export async function saveReel(input: z.input<typeof saveSchema>): Promise<SaveResult> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", message: "Could not read the changes." };

  let timeline: Timeline;
  try {
    timeline = parseTimeline(parsed.data.timeline);
  } catch {
    return { ok: false, reason: "invalid", message: "The edit is not valid and was not saved." };
  }

  const user = await getCurrentUser();
  // Every asset in the timeline must belong to this workspace.
  const assetIds = referencedAssetIds(timeline);
  if (assetIds.length > 0) {
    const owned = await prisma.mediaAsset.count({ where: { id: { in: assetIds }, workspaceId: user.workspaceId } });
    if (owned !== assetIds.length) return { ok: false, reason: "invalid", message: "The edit uses media from another workspace." };
  }

  const { id, revision, title } = parsed.data;
  const updated = await prisma.reel.updateMany({
    where: { id, workspaceId: user.workspaceId, revision },
    data: { timeline, revision: { increment: 1 }, ...(title ? { title } : {}) },
  });
  if (updated.count === 0) {
    const exists = await prisma.reel.count({ where: { id, workspaceId: user.workspaceId } });
    return exists
      ? { ok: false, reason: "conflict", message: "This reel was changed in another tab. Reload to see the latest version." }
      : { ok: false, reason: "missing", message: "This reel was deleted." };
  }
  return { ok: true, revision: revision + 1 };
}

/**
 * The Instagram post text. Saved on its own, outside the timeline revision,
 * so typing a caption never conflicts with the editor's autosave.
 */
export async function saveCaption(input: { id: string; caption: string }): Promise<{ ok: boolean }> {
  const caption = z.string().max(5000).safeParse(input.caption);
  if (!caption.success) return { ok: false };
  const user = await getCurrentUser();
  const updated = await prisma.reel.updateMany({ where: { id: input.id, workspaceId: user.workspaceId }, data: { caption: caption.data } });
  return { ok: updated.count === 1 };
}

export async function deleteReel(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  await prisma.reel.deleteMany({ where: { id: String(formData.get("id") ?? ""), workspaceId: user.workspaceId } });
  revalidatePath("/");
  redirect("/");
}

/**
 * Switches the public link for a reel on or off. The token is random and
 * long; turning the link off makes every copy of it dead.
 */
export async function setShareLink(input: { id: string; enabled: boolean }): Promise<{ url: string | null }> {
  const user = await getCurrentUser();
  const reel = await prisma.reel.findFirst({ where: { id: input.id, workspaceId: user.workspaceId }, select: { shareToken: true } });
  if (!reel) return { url: null };
  const shareToken = input.enabled ? (reel.shareToken ?? randomBytes(12).toString("base64url")) : null;
  if (shareToken !== reel.shareToken) {
    await prisma.reel.updateMany({ where: { id: input.id, workspaceId: user.workspaceId }, data: { shareToken } });
  }
  revalidatePath(`/reels/${input.id}/export`);
  return { url: shareToken ? `${await appUrl()}/r/${shareToken}` : null };
}

export type ExportResult = { ok: false; issues: Issue[]; message?: string };

/**
 * Freezes the current timeline into a render job and queues it. The checks
 * run again here, on the server, whatever the browser showed. The job row and
 * its queue message are written in one transaction (the outbox).
 */
export async function exportReel(input: { id: string }): Promise<ExportResult> {
  const user = await getCurrentUser();
  const reel = await prisma.reel.findFirst({ where: { id: input.id, workspaceId: user.workspaceId } });
  if (!reel) return { ok: false, issues: [], message: "This reel was deleted." };

  const timeline = parseTimeline(reel.timeline);
  const issues = instagramIssues(timeline, reel.caption);
  if (!canExport(issues)) return { ok: false, issues };

  const library = await prisma.mediaAsset.findMany({
    where: { id: { in: referencedAssetIds(timeline) }, ...mediaScope(user.workspaceId) },
    select: { id: true, objectKey: true, kind: true },
  });
  let payload;
  try {
    payload = buildReelExportPayload(timeline, library);
  } catch (error) {
    return { ok: false, issues: [], message: error instanceof Error ? error.message : "Could not export." };
  }

  await prisma.$transaction(async (tx) => {
    const job = await tx.renderJob.create({
      data: {
        workspaceId: user.workspaceId,
        createdById: user.id,
        reelId: reel.id,
        kind: "REEL",
        payload,
        caption: reel.title,
      },
    });
    await queueRenderJob(tx, job);
  });
  await flushOutbox();
  revalidatePath("/exports");
  redirect(`/reels/${reel.id}/export`);
}

export async function retryRenderJob(formData: FormData): Promise<void> {
  const jobId = String(formData.get("jobId") ?? "");
  const user = await getCurrentUser();

  // FAILED -> QUEUED as a single conditional write: two taps (or two tabs)
  // can only ever produce one new generation and one new message.
  const job = await prisma.$transaction(async (tx) => {
    const retried = await tx.renderJob.updateManyAndReturn({
      where: { id: jobId, workspaceId: user.workspaceId, status: "FAILED" },
      data: {
        status: "QUEUED",
        generation: { increment: 1 },
        attempt: 0,
        progress: 0,
        error: null,
        heartbeatAt: null,
        startedAt: null,
        finishedAt: null,
      },
    });
    if (retried[0]) await queueRenderJob(tx, retried[0]);
    return retried[0];
  });
  if (job) await flushOutbox();

  if (job?.reelId) revalidatePath(`/reels/${job.reelId}/export`);
  revalidatePath("/exports");
}

// ── Uploads ─────────────────────────────────────────────────────

const uploadRequestSchema = z.object({
  fileName: z.string().min(1).max(200),
  contentType: z.string().max(100),
  sizeBytes: z.number().int().positive(),
  withThumbnail: z.boolean(),
});

export type UploadTicket =
  | { ok: true; objectKey: string; contentType: string; uploadUrl: string; thumbKey: string | null; thumbUrl: string | null }
  | { ok: false; error: string };

/**
 * Step 1 of an upload. Neither the file nor its thumbnail passes through
 * Next.js: the browser PUTs both straight to storage with these URLs.
 */
export async function createUpload(input: z.input<typeof uploadRequestSchema>): Promise<UploadTicket> {
  const parsed = uploadRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Could not read the file details." };
  const { fileName, contentType, sizeBytes, withThumbnail } = parsed.data;

  const resolved = resolveUploadType(contentType, fileName);
  if (!resolved) return { ok: false, error: `${fileName} is not a supported photo, video or audio file.` };
  if (sizeBytes > MAX_UPLOAD_BYTES) return { ok: false, error: `${fileName} is larger than 2 GB.` };

  const user = await getCurrentUser();
  const objectKey = uploadKeyFor(user.workspaceId, randomUUID(), resolved.extension);
  const thumbKey = withThumbnail && resolved.kind !== "AUDIO" ? thumbKeyFor(objectKey) : null;
  const [uploadUrl, thumbUrl] = await Promise.all([
    presignUpload(objectKey, resolved.contentType),
    thumbKey ? presignUpload(thumbKey, "image/jpeg") : null,
  ]);
  return { ok: true, objectKey, contentType: resolved.contentType, uploadUrl, thumbKey, thumbUrl };
}

const confirmSchema = z.object({
  objectKey: z.string().min(1),
  thumbKey: z.string().nullable(),
  fileName: z.string().min(1).max(200),
  durationMs: z.number().int().positive().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  /** Tempo of a song, detected in the browser. */
  bpm: z.number().min(40).max(240).nullable().optional(),
  beatOffsetMs: z.number().int().min(0).nullable().optional(),
});

export type ConfirmResult = { ok: true; asset: LibraryAsset } | { ok: false; error: string };

/** Step 2 of an upload: record the asset once the object really exists in storage. */
export async function confirmUpload(input: z.input<typeof confirmSchema>): Promise<ConfirmResult> {
  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Could not read the upload details." };
  const data = parsed.data;

  const user = await getCurrentUser();
  if (!data.objectKey.startsWith(`uploads/${user.workspaceId}/`)) return { ok: false, error: "This upload belongs to another workspace." };

  const head = await headObject(data.objectKey);
  if (!head) return { ok: false, error: `${data.fileName} did not reach storage. Try again.` };
  const resolved = resolveUploadType(head.contentType, data.objectKey);
  if (!resolved) return { ok: false, error: `${data.fileName} is not a supported file.` };
  const thumbKey = data.thumbKey && data.thumbKey === thumbKeyFor(data.objectKey) && (await headObject(data.thumbKey)) ? data.thumbKey : null;

  const asset = await prisma.mediaAsset.upsert({
    where: { objectKey: data.objectKey },
    update: {},
    create: {
      workspaceId: user.workspaceId,
      kind: resolved.kind,
      objectKey: data.objectKey,
      thumbKey,
      contentType: resolved.contentType,
      fileName: data.fileName,
      sizeBytes: head.sizeBytes,
      durationMs: resolved.kind === "IMAGE" ? null : data.durationMs,
      width: data.width,
      height: data.height,
      bpm: resolved.kind === "AUDIO" ? (data.bpm ?? null) : null,
      beatOffsetMs: resolved.kind === "AUDIO" ? (data.beatOffsetMs ?? null) : null,
    },
  });
  return { ok: true, asset: await toLibraryAsset(asset) };
}
