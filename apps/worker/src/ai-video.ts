import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { claimAiGeneration, failAiGeneration, prisma } from "@reelwalk/db";
import { VertexError, VertexVideo, definitelyRejected } from "./vertex-video";
import { aiThumbnail } from "./ai-thumbnail";
import { aiFrames, decodeFrame, keyframes, type DecodedFrame } from "./ai-frames";
import { VertexImages, type InlineImage } from "./vertex-images";
import { fetchVideo, lipsyncConfigured, pollLipsync, startLipsync, synthesiseLine, voicedPrompt } from "./voice";
import { transcribeVideo, transcriptionAvailable } from "./transcribe";
import { clipSchema, escalateFraming, insertAiShot, lineTrim, parseStoredAiShot, speakingFraming, timelineSchema, type AiShot, type PresenterFraming } from "@reelwalk/core";
import { identityDecision, identityRejectionMessage, minFacePx, speakingEnd, type IdentityVerdict, type LocateAttempt } from "./identity";

let provider: VertexVideo | undefined;
let images: VertexImages | undefined;
const inline = (frame?: DecodedFrame): InlineImage | undefined => frame && { bytesBase64Encoded: frame.bytesBase64Encoded, mimeType: frame.mimeType };
type Job = NonNullable<Awaited<ReturnType<typeof claimAiGeneration>>>;
const LIPSYNC = "lipsync:";

/** The spoken line and voice mode of a take, when it has one (ADR 0038). */
function voiceOf(shot: AiShot | undefined): { line: string; mode: "lipsync" | "veo" } | null {
  return shot?.line && shot.voice ? { line: shot.line, mode: shot.voice } : null;
}

/** A submission's claim; renewed while its stills are prepared (ADR 0056). */
export const AI_SUBMIT_LEASE_MS = 300_000;
const HEARTBEAT_MS = 30_000;
export const UNRESOLVED_MESSAGE = "We couldn't confirm whether this take was made. Your credit is held; it won't be charged twice.";
/** Waits between attempts to save an operation Google returned; tests set them to zero. */
export const aiVideoTiming = { saveBackoffMs: [1000, 3000, 9000] };

export async function processAiVideo(s3: S3Client, bucket: string): Promise<boolean> {
  // Recover an interrupted submission conservatively: never submit it again. One still being prepared
  // (no submitStartedAt) was never sent and is refunded; one past the fence may have been sent and is
  // left UNRESOLVED without a refund (ADR 0049's rule). Both updates are conditional, so a worker that
  // renewed its lease or reached the fence in the meantime keeps the job.
  const now = new Date();
  const stale = await prisma.aiGeneration.findFirst({ where: { status: "SUBMITTING", leaseUntil: { lt: now } } });
  if (stale) {
    if (stale.submitStartedAt) {
      await prisma.aiGeneration.updateMany({ where: { id: stale.id, status: "SUBMITTING", leaseUntil: { lt: now }, submitStartedAt: { not: null } }, data: { status: "UNRESOLVED", error: UNRESOLVED_MESSAGE } });
    } else {
      // Provably never sent: return the credit and the budget reservation.
      await failAiGeneration(prisma, stale.id, "Generation was interrupted. Your credit was returned; please try again.", true,
        { onlyIf: { status: "SUBMITTING", submitStartedAt: null, leaseUntil: { lt: now } } });
    }
    return true;
  }
  const job = await claimAiGeneration(prisma);
  if (!job) return false;
  const shot = parseStoredAiShot(job.shot);
  const voice = voiceOf(shot.success ? shot.data : undefined);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  /** Past the fence: from here an error may follow a paid submission and is never a refund. */
  let sent = false;
  try {
    provider ??= new VertexVideo(undefined, undefined, s3.config.credentials);
    if (job.status === "SUBMITTING") {
      // Keep the claim alive while stills are decoded, composed and checked; a lost claim never reaches Veo.
      heartbeat = setInterval(() => { void renewLease(job).catch(() => undefined); }, HEARTBEAT_MS);
      heartbeat.unref?.();
      let image: InlineImage | undefined, lastFrame: InlineImage | undefined;
      let identity: { identityScore: number; identityChecks: IdentityCheck[] } | undefined;
      if (job.frameSources) {
        let frames: ReturnType<typeof keyframes>;
        try {
          frames = keyframes(await aiFrames(s3, bucket, job.frameSources));
        } catch {
          await refund(job, "The source frames could not be read. Your credit was returned.");
          return true;
        }
        image = inline(frames.image); lastFrame = inline(frames.lastFrame);
        // Composed keyframes (ADR 0036): the presenter placed into the real frame before Veo sees it,
        // and (ADR 0056) checked against her face before anything is paid.
        if (frames.presenter && (frames.image?.compose || frames.lastFrame?.compose)) {
          const outcome = await composeAndGate(s3, bucket, job, frames);
          if (!outcome.ok) return true;
          image = outcome.image ?? image; lastFrame = outcome.lastFrame ?? lastFrame;
          identity = outcome.identity;
        }
      } else if (job.referenceKey) {
        const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: job.referenceKey }));
        if (!result.Body || (result.ContentLength ?? 0) > 20 * 1024 * 1024) {
          await refund(job, "That photo could not be read. Your credit was returned.");
          return true;
        }
        const bytes = await result.Body.transformToByteArray();
        image = { bytesBase64Encoded: Buffer.from(bytes).toString("base64"), mimeType: job.referenceType! };
      }
      if (voice?.mode === "lipsync" && !lipsyncConfigured()) {
        await refund(job, "Voiced shots are not available yet. Your credit was returned.");
        return true;
      }
      const prompt = voice ? voicedPrompt(job.prompt, voice.line, voice.mode) : job.prompt;
      clearInterval(heartbeat); heartbeat = undefined;
      // The fence: only the lease holder of a row nobody has refunded may pay, and it says so before it does.
      const fenced = await prisma.aiGeneration.updateMany({ where: { id: job.id, leaseToken: job.leaseToken, status: "SUBMITTING", submitStartedAt: null },
        data: { submitStartedAt: new Date(), leaseUntil: new Date(Date.now() + AI_SUBMIT_LEASE_MS) } });
      if (fenced.count !== 1) {
        console.warn(`ai-video: ${job.id}: claim lost before submitting; not sent`);
        return true;
      }
      sent = true;
      let operationName: string;
      try {
        operationName = await provider.submit(job.model, job.durationSeconds, prompt, image, lastFrame, voice?.mode === "veo");
      } catch (error) {
        if (definitelyRejected(error)) {
          // Google refused it outright: nothing was made, so the credit and budget go back.
          await failAiGeneration(prisma, job.id, "The video service could not start this shot. Your credit was returned.", true, { onlyIf: { leaseToken: job.leaseToken } });
        } else {
          // A timeout, network error, 5xx or abort may have started a paid operation: hold, never refund or resend.
          await markUnresolved(job);
        }
        console.error(`ai-video: ${job.id}: submit ${definitelyRejected(error) ? "rejected" : "outcome unknown"}: ${error instanceof Error ? error.message : "unknown"}`);
        return true;
      }
      await saveOperation(job, operationName, identity);
    } else {
      if (!job.operationName) throw new Error("Missing video operation.");
      if (Date.now() - job.createdAt.getTime() > 60 * 60_000) {
        await failAiGeneration(prisma, job.id, "Google took too long to return this shot. Your credit was returned.");
        return true;
      }
      if (job.operationName.startsWith(LIPSYNC)) {
        // The voice stage: the silent take and the spoken line are with sync.so.
        const status = await pollLipsync(job.operationName.slice(LIPSYNC.length));
        if (!status.done) {
          await prisma.aiGeneration.updateMany({ where: { id: job.id, leaseToken: job.leaseToken }, data: { nextPollAt: new Date(Date.now() + 20_000), leaseToken: null, leaseUntil: null } });
        } else if ("url" in status) {
          await finish(s3, bucket, job, await fetchVideo(status.url), shot.success ? shot.data : undefined, voice);
        } else {
          // The take exists without the voice; keep it rather than lose a paid generation.
          console.error(`ai-video: ${job.id}: lip sync failed: ${status.error}`);
          const silent = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `workspaces/${job.workspaceId}/ai/${job.id}-silent.mp4` }));
          await finish(s3, bucket, job, Buffer.from(await silent.Body!.transformToByteArray()), shot.success ? shot.data : undefined, null, "silent");
        }
        return true;
      }
      const result = await provider.poll(job.model, job.operationName);
      if (result.error) {
        await failAiGeneration(prisma, job.id, result.error);
      } else if (result.video) {
        if (voice?.mode === "lipsync") await startVoice(s3, bucket, job, result.video, voice.line);
        else await finish(s3, bucket, job, result.video, shot.success ? shot.data : undefined, voice);
      } else {
        if (Date.now() - job.createdAt.getTime() > 60 * 60_000) {
          await failAiGeneration(prisma, job.id, "Google took too long to return this shot. Your credit was returned.");
        } else await prisma.aiGeneration.updateMany({ where: { id: job.id, leaseToken: job.leaseToken }, data: {
          nextPollAt: new Date(Date.now() + 15_000), leaseToken: null, leaseUntil: null,
        } });
      }
    }
  } catch (error) {
    if (job.status === "SUBMITTING" && sent) {
      await markUnresolved(job).catch(() => undefined);
    } else if (job.status === "SUBMITTING") {
      // Before the fence nothing was sent: refund while it is still this worker's.
      await refund(job, "The video service could not start this shot. Your credit was returned.");
    } else {
      // Poll/import failures retry the saved operation, never a new generation.
      await prisma.aiGeneration.updateMany({ where: { id: job.id, leaseToken: job.leaseToken }, data: {
        nextPollAt: new Date(Date.now() + 30_000), leaseToken: null, leaseUntil: null,
      } });
    }
    console.error(`ai-video: ${job.id}: ${error instanceof VertexError ? error.message : "temporary processing error"}`);
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

/** Hold a submission whose outcome is unknown (ADR 0049's rule): no refund, no resend. */
async function markUnresolved(job: Job, operationName?: string) {
  await prisma.aiGeneration.updateMany({ where: { id: job.id, leaseToken: job.leaseToken, status: { in: ["SUBMITTING", "UNRESOLVED"] } },
    data: { status: "UNRESOLVED", error: UNRESOLVED_MESSAGE, ...(operationName ? { operationName } : {}) } });
}

/**
 * Save the operation Google returned so the take is polled. It is never
 * submitted again: a failed save is retried with backoff, and if it still
 * fails the row is held UNRESOLVED with the operation name logged (and
 * stored if the database allows) so it can be reconciled.
 */
async function saveOperation(job: Job, operationName: string, identity: { identityScore: number; identityChecks: unknown[] } | undefined) {
  for (let attempt = 0; ; attempt++) {
    try {
      // An UNRESOLVED row is this submission seen by recovery after a long call: saving the operation resolves it.
      await prisma.aiGeneration.updateMany({ where: { id: job.id, leaseToken: job.leaseToken, status: { in: ["SUBMITTING", "UNRESOLVED"] } }, data: {
        status: "RUNNING", error: null, operationName, nextPollAt: new Date(Date.now() + 15_000), leaseToken: null, leaseUntil: null,
        ...(identity ? { identityScore: identity.identityScore, identityChecks: identity.identityChecks as never } : {}),
      } });
      return;
    } catch (error) {
      const wait = aiVideoTiming.saveBackoffMs[attempt];
      if (wait === undefined) {
        console.error(`ai-video: ${job.id}: operation ${operationName} was started but could not be saved (${error instanceof Error ? error.message : "unknown"}); held UNRESOLVED for reconciliation`);
        await markUnresolved(job, operationName).catch(() => console.error(`ai-video: ${job.id}: could not mark UNRESOLVED; reconcile operation ${operationName} by hand`));
        return;
      }
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
}

/** Extend a submission's claim while it is still being prepared; false once it is no longer this worker's. */
async function renewLease(job: Job): Promise<boolean> {
  const renewed = await prisma.aiGeneration.updateMany({ where: { id: job.id, leaseToken: job.leaseToken, status: "SUBMITTING", submitStartedAt: null },
    data: { leaseUntil: new Date(Date.now() + AI_SUBMIT_LEASE_MS) } });
  return renewed.count === 1;
}

/** Refund a submission this worker still holds and has not sent (ADR 0056); a no-op if recovery already settled it. */
function refund(job: Job, message: string, details: Omit<NonNullable<Parameters<typeof failAiGeneration>[4]>, "onlyIf"> = {}) {
  return failAiGeneration(prisma, job.id, message, true, { ...details, onlyIf: { leaseToken: job.leaseToken, submitStartedAt: null } });
}

/** One gate verdict as stored in identityChecks, with the locate boxes and crops so a false reject can be diagnosed. */
type IdentityCheck = { end: "first" | "last"; attempt: 1 | 2; samePerson: boolean | null; confidence: number | null; faceHeightPx: number | null;
  minFacePx: number; /** The framing the still was composed at (ADR 0069), so the measured face can be read against what was asked. */ framing?: PresenterFraming;
  eyesAndMouthRendered?: boolean; reason?: IdentityVerdict["reason"]; locate?: LocateAttempt[] };

/**
 * Compose each described end and check her face before Veo is paid (ADR 0056).
 * A miss is recomposed once with a stronger instruction; a second miss
 * refunds the credit and records identity_rejected with both scores.
 */
async function composeAndGate(s3: S3Client, bucket: string, job: Job, frames: ReturnType<typeof keyframes>): Promise<
  { ok: true; image?: InlineImage; lastFrame?: InlineImage; identity: { identityScore: number; identityChecks: IdentityCheck[] } } | { ok: false }> {
  const presenter = inline(frames.presenter)!, face = inline(frames.face);
  // Who she should be: the kit's face crop, or for an older frame-only request the presenter frame itself.
  const reference = face ?? presenter;
  const voiceMode = parseStoredAiShot(job.shot).data?.voice ?? null;
  const checks: IdentityCheck[] = [];
  const result: { image?: InlineImage; lastFrame?: InlineImage } = {};
  images ??= new VertexImages(undefined, undefined, s3.config.credentials);
  for (const [end, frame] of [["first", frames.image], ["last", frames.lastFrame]] as const) {
    if (!frame?.compose) continue;
    // A speaking end needs a bigger face, since Veo and lip sync animate her eyes and mouth (ADR 0056),
    // except a shouted Veo line over a described wide or action shot.
    const speaking = speakingEnd(voiceMode, frame.compose);
    const minimum = minFacePx(speaking);
    let accepted: InlineImage | null = null;
    let previous: IdentityVerdict | null = null;
    // The framing (ADR 0069): at least close for a speaking end, a step closer after a face too small to judge. The plate
    // was cropped for the framing asked at reserve time; when the framing moves, the plate is cropped again to match.
    const asked: PresenterFraming = frame.framing ?? "medium";
    let framing: PresenterFraming = speaking ? speakingFraming(asked) : asked;
    let cropped: PresenterFraming = asked;
    let scene: InlineImage = inline(frame)!;
    for (const attempt of [1, 2] as const) {
      let composed: InlineImage;
      try {
        const closer = attempt === 2 && previous?.reason === "face-too-small";
        if (closer) framing = escalateFraming(framing);
        if (framing !== cropped && frame.source) {
          scene = await recropScene(s3, bucket, frame, framing) ?? scene;
          cropped = framing;
        }
        composed = await images.compose(end, frame.compose, scene, presenter, face, { framing, stronger: attempt === 2, ...(closer ? { closer: true } : {}) });
      } catch {
        await refund(job, "The start and end stills could not be composed. Your credit was returned.", { identityChecks: checks });
        return { ok: false };
      }
      let verdict: IdentityVerdict | null = null;
      try { verdict = await images.checkIdentity(composed, reference, { minFacePx: minimum }); } catch { verdict = null; }
      checks.push({ end, attempt, samePerson: verdict?.samePerson ?? null, confidence: verdict?.confidence ?? null, faceHeightPx: verdict?.faceHeightPx ?? null, minFacePx: minimum, framing,
        ...(verdict?.eyesAndMouthRendered !== undefined ? { eyesAndMouthRendered: verdict.eyesAndMouthRendered } : {}),
        ...(verdict?.reason ? { reason: verdict.reason } : {}), ...(verdict?.locate ? { locate: verdict.locate } : {}) });
      console.log(`ai-video: ${job.id}: identity ${end} attempt ${attempt} (${framing}): ${verdict ? `${verdict.samePerson ? "same" : "different"} person, confidence ${verdict.confidence.toFixed(2)}, face ${verdict.faceHeightPx ?? "?"} px (min ${minimum}), eyes/mouth ${verdict.eyesAndMouthRendered ?? "?"}${verdict.reason ? `, ${verdict.reason}` : ""}, locate ${JSON.stringify(verdict.locate ?? [])}` : "check unavailable"}`);
      // Kept beside the take so the studio can see what Veo was (or would have been) given.
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `workspaces/${job.workspaceId}/ai/${job.id}-${end}${attempt === 2 ? "-retry" : ""}.jpg`, Body: Buffer.from(composed.bytesBase64Encoded, "base64"), ContentType: "image/jpeg" }));
      // Each attempt is a few slow calls: stop as soon as the claim is gone, before any more spend.
      if (!await renewLease(job)) { console.warn(`ai-video: ${job.id}: claim lost while composing; not sent`); return { ok: false }; }
      const decision = identityDecision(attempt, verdict, minimum);
      previous = verdict;
      if (decision === "pass") { accepted = composed; break; }
      if (decision === "reject") {
        const lowest = Math.min(...checks.map(check => check.confidence ?? 0));
        await refund(job, identityRejectionMessage(end, verdict, minimum, speaking),
          { failureCode: "identity_rejected", identityScore: lowest, identityChecks: checks });
        return { ok: false };
      }
    }
    if (end === "first") result.image = accepted!; else result.lastFrame = accepted!;
  }
  // The lowest accepted score across the composed ends (each end's last check passed): drift shows up here over time.
  const finals = (["first", "last"] as const).flatMap(end => checks.filter(check => check.end === end).slice(-1).map(check => check.confidence ?? 0));
  const identityScore = Math.min(...finals);
  return { ok: true, ...result, identity: { identityScore, identityChecks: checks } };
}

/** The scene cropped again for a closer framing (ADR 0069); null when it cannot be decoded, so the last crop is kept. */
async function recropScene(s3: S3Client, bucket: string, frame: DecodedFrame, framing: PresenterFraming): Promise<InlineImage | null> {
  if (!frame.source) return null;
  try {
    const bytes = await decodeFrame(s3, bucket, frame.source.key, frame.source.atMs, "scene-png", framing);
    return { bytesBase64Encoded: bytes.toString("base64"), mimeType: "image/png" };
  } catch {
    return null;
  }
}

/** Speak the line in the fixed voice, hand the silent take and the audio to sync.so, and poll it like Veo. */
async function startVoice(s3: S3Client, bucket: string, job: Job, silent: Buffer, line: string) {
  const prefix = `workspaces/${job.workspaceId}/ai/${job.id}`;
  const audio = await synthesiseLine(line);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}-silent.mp4`, Body: silent, ContentType: "video/mp4" }));
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}-line.mp3`, Body: audio, ContentType: "audio/mpeg" }));
  const [videoUrl, audioUrl] = await Promise.all([
    getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: `${prefix}-silent.mp4` }), { expiresIn: 3600 }),
    getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: `${prefix}-line.mp3` }), { expiresIn: 3600 }),
  ]);
  const id = await startLipsync(videoUrl, audioUrl, `reelwalk-${job.id}`);
  await prisma.aiGeneration.updateMany({ where: { id: job.id, leaseToken: job.leaseToken, status: "RUNNING" }, data: {
    operationName: `${LIPSYNC}${id}`, nextPollAt: new Date(Date.now() + 20_000), leaseToken: null, leaseUntil: null,
  } });
}

/** Words with timings for a voiced take, so captions and ducking work on it like any upload. */
async function transcript(video: Buffer, id: string) {
  if (!transcriptionAvailable()) return null;
  const workdir = await mkdtemp(path.join(os.tmpdir(), `voice-${id}-`));
  try {
    const file = path.join(workdir, "take.mp4");
    await writeFile(file, video);
    return await transcribeVideo(file, workdir, 20);
  } catch (error) {
    console.warn(`ai-video: ${id}: transcript not made: ${error instanceof Error ? error.message : error}`);
    return null;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

/** Store the take, make its thumbnail and library record, and assemble the promo draft when asked. */
async function finish(s3: S3Client, bucket: string, job: Job, video: Buffer, shot: AiShot | undefined, voice: { line: string; mode: "lipsync" | "veo" } | null, note?: "silent") {
  const objectKey = `workspaces/${job.workspaceId}/ai/${job.id}.mp4`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: video, ContentType: "video/mp4" }));
  const thumbKey = `workspaces/${job.workspaceId}/ai/${job.id}.jpg`;
  const thumbnail = await aiThumbnail(video);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: thumbKey, Body: thumbnail, ContentType: "image/jpeg" }));
  const words = voice ? await transcript(video, job.id) : null;
  // The auto-trim (ADR 0069): where the line sits in the take, and whether the take said it; only when words were heard.
  const take = voice && words ? lineTrim(words, voice.line, job.durationSeconds * 1000) : null;
  const transcriptRecord = words ? { ...words, ...(take ? { take } : {}) } : null;
  if (take) console.log(`ai-video: ${job.id}: line trim ${take.startMs}-${take.endMs} ms, distance ${take.distance}${take.wrongWords ? `, WRONG WORDS: heard "${take.heard}"` : ""}`);
  await prisma.$transaction(async tx => {
    const changed = await tx.aiGeneration.updateMany({ where: { id: job.id, leaseToken: job.leaseToken, status: "RUNNING" }, data: {
      status: "SUCCEEDED", assetId: `ai-${job.id}`, finishedAt: new Date(), leaseToken: null, leaseUntil: null,
      ...(note === "silent" ? { error: "The voice could not be added to this take; it is saved silent." } : {}),
    } });
    if (!changed.count) return;
    await tx.mediaAsset.upsert({ where: { objectKey }, update: { thumbKey }, create: {
      id: `ai-${job.id}`, workspaceId: job.workspaceId, kind: "VIDEO", objectKey, thumbKey, previewKey: objectKey,
      contentType: "video/mp4", fileName: `AI shot — ${voice ? `"${voice.line.slice(0, 40)}"` : job.prompt.slice(0, 60)}${note === "silent" ? " (silent)" : ""}.mp4`,
      sizeBytes: BigInt(video.length), durationMs: job.durationSeconds * 1000, width: 1080, height: 1920,
      attribution: "AI-generated with Google Veo",
      ...(transcriptRecord ? { transcript: transcriptRecord as never } : {}),
    } });
    if (shot?.draftReelId) {
      const source = await tx.reel.findFirst({ where: { id: shot.draftReelId, workspaceId: job.workspaceId } });
      const parsed = timelineSchema.safeParse(source?.timeline);
      if (source && parsed.success) {
        const timeline = parsed.data;
        const clip = clipSchema.parse({ id: `ai-insert-ai-${job.id}`, assetId: `ai-${job.id}`, kind: "VIDEO", sourceStartMs: 0, sourceEndMs: job.durationSeconds * 1000 });
        const next = insertAiShot(timeline, clip, shot);
        // A changed/deleted boundary leaves the clip in the library for review.
        if (next !== timeline) await tx.reel.upsert({ where: { id: `ai-promo-${job.id}` }, update: {}, create: {
          id: `ai-promo-${job.id}`, workspaceId: job.workspaceId, title: `${source.title.slice(0, 65)} · AI promo`,
          timeline: next, caption: source.caption,
        } });
      }
    }
  });
}
