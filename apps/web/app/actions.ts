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
} from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { toLibraryAsset, toLibraryAssets, type LibraryAsset } from "@/lib/library";
import { saveReelFor, type SaveResult } from "@/lib/save-reel";
import { workspacePlan } from "@/lib/plans";
import { exportBlockedReason, retryBlockedReason, storageBlockedReason } from "@/lib/quotas";
import { ensureWorkerRunning } from "@/lib/render-capacity";
import { flushOutbox, queueRenderJob } from "@/lib/render-jobs";
import { abortMultipartUpload, completeMultipartUpload, headObject, presignUpload, startMultipartUpload, UPLOAD_PART_BYTES } from "@/lib/storage";
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
      // Never an Instagram sound's private copy: it is only for editing against.
      where: { ...mediaScope(user.workspaceId), kind: "AUDIO", bpm: { not: null }, instagramAudioId: null },
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

export type { SaveResult } from "@/lib/save-reel";

/** Autosave as a server action. The editor saves through /api/reels/[id]/save, which survives deploys. */
export async function saveReel(input: { id: string; revision: number; timeline: unknown; title?: string }): Promise<SaveResult> {
  const user = await getCurrentUser();
  return saveReelFor(user, input);
}

/**
 * The Instagram post text. Saved on its own, outside the timeline revision,
 * so typing a caption never conflicts with the editor's autosave.
 */
/**
 * Preview URLs for videos whose preview has been made since the editor
 * loaded, so it can switch from the heavy original without a reload.
 */
export async function readyPreviews(input: { ids: string[] }): Promise<{ id: string; url: string }[]> {
  const ids = z.array(z.string().min(1).max(64)).max(200).safeParse(input.ids);
  if (!ids.success || ids.data.length === 0) return [];
  const user = await getCurrentUser();
  const assets = await prisma.mediaAsset.findMany({
    where: { id: { in: ids.data }, previewKey: { not: null }, ...mediaScope(user.workspaceId) },
    select: { id: true, kind: true, fileName: true, objectKey: true, thumbKey: true, previewKey: true, durationMs: true, width: true, height: true },
  });
  return (await toLibraryAssets(assets)).map(asset => ({ id: asset.id, url: asset.url }));
}

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

export type ExportResult = { ok: false; issues: Issue[]; message?: string; /** A bigger plan would lift the limit that stopped it. */ upgrade?: boolean };

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
  const blocked = await exportBlockedReason(user.workspaceId);
  if (blocked) return { ok: false, issues: [], message: blocked.message, upgrade: blocked.upgrade };

  const library = await prisma.mediaAsset.findMany({
    where: { id: { in: referencedAssetIds(timeline) }, ...mediaScope(user.workspaceId) },
    // instagramAudioId marks an Instagram sound's copy, which the render leaves out (ADR 0019).
    select: { id: true, objectKey: true, kind: true, instagramAudioId: true, transcript: true },
  });
  const { plan } = await workspacePlan(user.workspaceId);
  let payload;
  try {
    payload = buildReelExportPayload(timeline, library, { width: plan.outputWidth, watermark: plan.watermark });
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
  await ensureWorkerRunning();
  revalidatePath("/exports");
  redirect(`/reels/${reel.id}/export`);
}

export async function retryRenderJob(formData: FormData): Promise<void> {
  const jobId = String(formData.get("jobId") ?? "");
  const user = await getCurrentUser();
  if (await retryBlockedReason(user.workspaceId)) redirect("/exports?busy=1");

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
  if (job) {
    await flushOutbox();
    await ensureWorkerRunning();
  }

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
  | {
      ok: true;
      objectKey: string;
      contentType: string;
      /** A single PUT for files up to MULTIPART_FROM_BYTES; null when the file goes up in parts. */
      uploadUrl: string | null;
      multipart: { uploadId: string; partBytes: number; partUrls: string[] } | null;
      thumbKey: string | null;
      thumbUrl: string | null;
    }
  | { ok: false; error: string };

/** Files above this size are uploaded in parts. */
const MULTIPART_FROM_BYTES = 32 * 1024 * 1024;

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
  const full = await storageBlockedReason(user.workspaceId, sizeBytes, fileName);
  if (full) return { ok: false, error: full };
  const objectKey = uploadKeyFor(user.workspaceId, randomUUID(), resolved.extension);
  const thumbKey = withThumbnail && resolved.kind !== "AUDIO" ? thumbKeyFor(objectKey) : null;
  const multipart = sizeBytes > MULTIPART_FROM_BYTES;
  const [uploadUrl, parts, thumbUrl] = await Promise.all([
    multipart ? null : presignUpload(objectKey, resolved.contentType),
    multipart ? startMultipartUpload(objectKey, resolved.contentType, sizeBytes) : null,
    thumbKey ? presignUpload(thumbKey, "image/jpeg") : null,
  ]);
  return {
    ok: true,
    objectKey,
    contentType: resolved.contentType,
    uploadUrl,
    multipart: parts ? { uploadId: parts.uploadId, partBytes: UPLOAD_PART_BYTES, partUrls: parts.partUrls } : null,
    thumbKey,
    thumbUrl,
  };
}

const partsSchema = z.object({
  objectKey: z.string().min(1).max(300),
  uploadId: z.string().min(1).max(1024),
  parts: z.array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(200) })).min(1).max(10_000),
});

/** Step 2 for a file uploaded in parts: storage joins them into one object. */
export async function completeUpload(input: z.input<typeof partsSchema>): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = partsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Could not read the upload details." };
  const user = await getCurrentUser();
  if (!parsed.data.objectKey.startsWith(`uploads/${user.workspaceId}/`)) return { ok: false, error: "This upload belongs to another workspace." };
  try {
    await completeMultipartUpload(parsed.data.objectKey, parsed.data.uploadId, parsed.data.parts);
    return { ok: true };
  } catch (error) {
    console.error("completeUpload failed", error);
    return { ok: false, error: "Storage could not finish the upload. Try again." };
  }
}

/** Gives up on a file uploaded in parts, so storage drops what arrived. */
export async function abortUpload(input: { objectKey: string; uploadId: string }): Promise<void> {
  const user = await getCurrentUser();
  if (typeof input?.objectKey !== "string" || typeof input?.uploadId !== "string") return;
  if (!input.objectKey.startsWith(`uploads/${user.workspaceId}/`)) return;
  await abortMultipartUpload(input.objectKey, input.uploadId).catch(() => undefined);
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
  /** The room the shot list says this was filmed as (ADR 0063). */
  room: z.string().trim().toLowerCase().min(1).max(40).nullable().optional(),
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
  // The size declared up front is the client's word; this is what arrived.
  const full = await storageBlockedReason(user.workspaceId, head.sizeBytes, data.fileName);
  if (full) return { ok: false, error: full };
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
      room: resolved.kind === "AUDIO" ? null : (data.room ?? null),
    },
  });

  // A phone video can be 4K at 20+ Mbit/s, which stalls the editor's preview
  // for seconds on every clip change. A worker makes a 720p rendition; the
  // editor switches to it on the next load. The job goes through the same
  // queue and outbox as an export.
  if (asset.kind === "VIDEO" && !asset.previewKey) {
    await prisma.$transaction(async (tx) => {
      const job = await tx.renderJob.create({
        data: { workspaceId: user.workspaceId, createdById: user.id, mediaAssetId: asset.id, kind: "PREVIEW", caption: data.fileName },
      });
      await queueRenderJob(tx, job);
    });
    await flushOutbox();
    await ensureWorkerRunning();
  }
  return { ok: true, asset: await toLibraryAsset(asset) };
}
