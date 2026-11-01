// The shot plan runner's real dependencies (ADR 0104). Kept apart from shot-plans.ts because it reaches into the web
// app (`@/`, ADR 0049): a take goes through createAiGeneration, the same reservation, credits, queue and checks as a take
// asked for in the editor or the connector.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { CHECK_SERIES, CONTINUITY_KEYFRAMES_PROMPT, CONTINUITY_TAKE_PROMPT, checkDecodeArgs, keyframePrompt, type Gray } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { createAiGeneration } from "@/lib/ai-video";
import { takeRequestId } from "@/lib/shot-plans";
import { decodeFrame } from "./ai-frames";
import { VertexImages, type InlineImage } from "./vertex-images";
import type { PlanDeps } from "./shot-plans";

const run = promisify(execFile);

/**
 * Grey frames of a whole video, as the render checks decode them (72×128, 30 a second). The motion code (motion.ts,
 * motion-kind.ts) works on 0..255 values, so the bytes are kept as they are.
 */
async function greySeries(url: string): Promise<{ t: number; gray: Gray }[]> {
  const { stdout } = await run("ffmpeg", checkDecodeArgs(url), { encoding: "buffer", maxBuffer: 128 * 1024 * 1024, timeout: 120_000 }) as unknown as { stdout: Buffer };
  const size = CHECK_SERIES.width * CHECK_SERIES.height;
  return Array.from({ length: Math.floor(stdout.length / size) }, (_, n) => ({
    t: Math.round((n * 1000) / CHECK_SERIES.fps),
    gray: { data: new Uint8Array(stdout.subarray(n * size, (n + 1) * size)), width: CHECK_SERIES.width, height: CHECK_SERIES.height },
  }));
}

/** One grey frame of a still or a video at a moment, the same size as greySeries's. */
async function greyFrame(url: string, atMs: number): Promise<Gray> {
  const { stdout } = await run("ffmpeg", ["-v", "error", "-nostdin", "-ss", (atMs / 1000).toFixed(3), "-i", url, "-frames:v", "1", "-an",
    "-vf", `scale=${CHECK_SERIES.width}:${CHECK_SERIES.height},format=gray`, "-f", "image2pipe", "-vcodec", "rawvideo", "-"],
  { encoding: "buffer", maxBuffer: 1024 * 1024, timeout: 60_000 }) as unknown as { stdout: Buffer };
  const size = CHECK_SERIES.width * CHECK_SERIES.height;
  if (stdout.length < size) throw new Error("A planned frame could not be decoded.");
  return { data: new Uint8Array(stdout.subarray(0, size)), width: CHECK_SERIES.width, height: CHECK_SERIES.height };
}

export function shotPlanDeps(s3: S3Client, bucket: string, log: (line: string) => void = (line) => console.log(line)): PlanDeps {
  let images: VertexImages | undefined;
  const signed = (key: string) => getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 600 });
  const assetUrl = async (assetId: string) => {
    const asset = await prisma.mediaAsset.findUnique({ where: { id: assetId }, select: { objectKey: true, kind: true } });
    if (!asset) throw new Error("A planned frame's media is no longer in the library.");
    return { url: await signed(asset.objectKey), asset };
  };
  const inline = async (key: string, kind: "IMAGE" | "VIDEO", atMs: number, output: "veo-jpeg" | "reference-png"): Promise<InlineImage> => {
    const bytes = await decodeFrame(s3, bucket, key, atMs, output);
    return { bytesBase64Encoded: bytes.toString("base64"), mimeType: output === "veo-jpeg" ? "image/jpeg" : "image/png" };
  };

  return {
    log,
    requestId: takeRequestId,
    async makeKeyframe({ user, planId, plan, shot, end, presenterId }) {
      images ??= new VertexImages(undefined, undefined, s3.config.credentials);
      const references: { image: InlineImage; role: string }[] = [];
      // Her kit's stills (ADR 0056): the full-length photo and the face crop, so the keyframe is her.
      let face: InlineImage | undefined;
      if (presenterId) {
        const kit = await prisma.presenter.findFirst({ where: { id: presenterId, workspaceId: user.workspaceId } });
        const body = kit ? await prisma.mediaAsset.findFirst({ where: { id: kit.fullBodyAssetId, workspaceId: user.workspaceId } }) : null;
        if (kit?.faceCropKey && body) {
          face = await inline(kit.faceCropKey, "IMAGE", 0, "reference-png");
          references.push({ image: await inline(body.objectKey, "IMAGE", 0, "reference-png"), role: "the presenter, full length: keep her exactly" });
          references.push({ image: face, role: "the presenter's face: match it exactly (eyes, nose, mouth, hairline, hair)" });
        }
      }
      // What must carry over: an end frame is the same place as its own start, moved; a start follows the shot before.
      const index = plan.shots.findIndex((s) => s.id === shot.id);
      const carry = end === "end" ? shot.start.assetId ? { id: shot.start.assetId, atMs: shot.start.atMs ?? 0, role: "this shot's start frame: the same place and light, seen from where the camera has moved to" } : null
        : index > 0 && plan.shots[index - 1].end.assetId ? { id: plan.shots[index - 1].end.assetId!, atMs: plan.shots[index - 1].end.atMs ?? 0, role: "the previous shot's last frame: the same property, materials and light" } : null;
      let carried: InlineImage | null = null;
      if (carry) {
        const asset = await prisma.mediaAsset.findUnique({ where: { id: carry.id }, select: { objectKey: true, kind: true } });
        if (asset) {
          carried = await inline(asset.objectKey, asset.kind as "IMAGE" | "VIDEO", carry.atMs, "veo-jpeg");
          references.push({ image: carried, role: carry.role });
        }
      }
      let prompt = keyframePrompt(plan, shot, end);
      let still = await images.keyframe(prompt, references);
      // The storyboard's continuity check (ADR 0104): an end still must be the same place as its start, or Veo morphs one
      // into the other mid-take. Checked here, before any video is paid for; remade once with what was wrong, then refused.
      const startStill = end === "end" ? carried : null;
      if (startStill) {
        const verdict = await images.judgeContinuity(CONTINUITY_KEYFRAMES_PROMPT, [startStill, still]).catch(() => null);
        if (verdict && !verdict.consistent) {
          log(`shot-plan ${planId}: ${shot.id} end keyframe contradicts its start: ${verdict.problems.join("; ")}`);
          prompt = `${prompt} Fix these contradictions with the start frame: ${verdict.problems.join("; ")}.`;
          still = await images.keyframe(prompt, references);
          const again = await images.judgeContinuity(CONTINUITY_KEYFRAMES_PROMPT, [startStill, still]).catch(() => null);
          if (again && !again.consistent) throw new Error(`The ${shot.id} end keyframe kept contradicting its start (${again.problems.join("; ").slice(0, 200)}); edit the frame's description.`);
        }
      }
      if (face) {
        // The identity gate (ADR 0056) on her keyframe: one remake when it is not her, then refuse rather than drift.
        const verdict = await images.checkIdentity(still, face).catch(() => null);
        if (verdict && !verdict.samePerson) {
          still = await images.keyframe(`${prompt} The presenter must be exactly the person in the reference images.`, references);
          const again = await images.checkIdentity(still, face).catch(() => null);
          if (again && !again.samePerson) throw new Error(`The ${shot.id} ${end} keyframe did not look like the presenter twice; edit the frame's description or the kit.`);
        }
      }
      const bytes = Buffer.from(still.bytesBase64Encoded, "base64");
      const id = `kf-${planId}-${shot.id}-${end}`.slice(0, 64);
      const objectKey = `workspaces/${user.workspaceId}/plans/${planId}/${shot.id}-${end}-${Date.now()}.jpg`;
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: bytes, ContentLength: bytes.byteLength, ContentType: "image/jpeg" }));
      await prisma.mediaAsset.upsert({
        where: { id },
        update: { objectKey, thumbKey: objectKey, previewKey: objectKey, sizeBytes: BigInt(bytes.byteLength) },
        create: { id, workspaceId: user.workspaceId, kind: "IMAGE", objectKey, thumbKey: objectKey, previewKey: objectKey, contentType: "image/jpeg",
          fileName: `Keyframe: ${plan.title.slice(0, 40)}, ${shot.id} ${end}.jpg`, sizeBytes: BigInt(bytes.byteLength), width: 1080, height: 1920,
          attribution: "AI-generated keyframe (Google Gemini)" },
      });
      return id;
    },
    async startTake({ user, requestId, prompt, shot, first, last }) {
      const row = await createAiGeneration(user, {
        requestId, prompt, durationSeconds: shot.seconds,
        shot: {
          mode: first && last ? "bridge" : first ? "continue" : "custom",
          ...(first ? { first } : {}), ...(last ? { last } : {}),
          ...(shot.move ? { move: shot.move } : {}),
          ...(shot.line ? { line: shot.line, voice: "veo" as const } : {}),
        } as never,
      }, { exactPrompt: true });
      return { id: row.id, credits: row.credits };
    },
    async takeStatus(id) {
      const row = await prisma.aiGeneration.findUnique({ where: { id }, select: { status: true, assetId: true, error: true, durationSeconds: true } });
      if (!row) return { status: "failed", error: "The take's record is gone." };
      if (row.status === "SUCCEEDED" && row.assetId) return { status: "succeeded", assetId: row.assetId, durationMs: row.durationSeconds * 1000 };
      if (row.status === "FAILED" || row.status === "UNRESOLVED") return { status: "failed", error: row.error };
      return { status: "waiting" };
    },
    async takeFrames(assetId) {
      const { url } = await assetUrl(assetId);
      return greySeries(url);
    },
    async judgeTake(assetId) {
      images ??= new VertexImages(undefined, undefined, s3.config.credentials);
      const asset = await prisma.mediaAsset.findUnique({ where: { id: assetId }, select: { objectKey: true, durationMs: true } });
      if (!asset?.durationMs) return null;
      // Seven frames from first to last: enough to see a wall turn into shelves, few enough for one quick request.
      const times = [0, 1, 2, 3, 4, 5, 6].map((i) => Math.min(asset.durationMs! - 40, Math.round((i / 6) * asset.durationMs!)));
      const frames = await Promise.all(times.map((t) => inline(asset.objectKey, "VIDEO", t, "veo-jpeg")));
      return images.judgeContinuity(CONTINUITY_TAKE_PROMPT, frames);
    },
    async stillFrame(frame) {
      const { url, asset } = await assetUrl(frame.assetId);
      return greyFrame(url, asset.kind === "VIDEO" ? frame.atMs : 0);
    },
  };
}
