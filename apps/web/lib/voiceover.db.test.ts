/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A voiceover (ADR 0099) against a real Postgres: the worker step is queued
 * through the outbox, the worker's answer is stood in for (the step and its
 * AUDIO asset written as the worker writes them), and the reel's voiceover
 * and captions land as one saved revision. Skipped without DATABASE_URL.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseTimeline } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";

vi.mock("./render-capacity", () => ({ ensureWorkerRunning: async () => undefined }));
vi.mock("./render-jobs", () => ({ flushOutbox: async () => undefined }));

import { addVoiceover, voiceoverRequestId } from "./voiceover";
import { startWorkerStepRun } from "./workflows";

const enabled = Boolean(process.env.DATABASE_URL);
const run = `vo${randomBytes(4).toString("hex")}`;
const transcript = { text: "Three bedrooms and a garden.", words: [{ w: "Three", s: 0, e: 300 }, { w: "bedrooms", s: 320, e: 900 }, { w: "and", s: 950, e: 1050 }, { w: "a", s: 1060, e: 1100 }, { w: "garden.", s: 1120, e: 1700 }] };

describe.skipIf(!enabled)("a voiceover against a real database", () => {
  beforeAll(() => vi.stubEnv("VOICE_ENABLED", "true"));
  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { slug: { startsWith: run } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: run } } });
    vi.unstubAllEnvs();
    await prisma.$disconnect();
  });

  it("queues the worker's step, waits for it, and saves the voiceover with its captions as one revision", async () => {
    const workspace = await prisma.workspace.create({ data: { slug: `${run}-1`, name: "Voice" } });
    const user = await prisma.user.create({ data: { email: `${run}-1@example.com`, name: "Owner", workspaceId: workspace.id } });
    const photo = (name: string) => prisma.mediaAsset.create({ data: { workspaceId: workspace.id, kind: "IMAGE", objectKey: `workspaces/${workspace.id}/${run}-${name}.jpg`, contentType: "image/jpeg", fileName: `${name}.jpg`, sizeBytes: 1000n } });
    const [p1, p2] = await Promise.all([photo("front"), photo("garden")]);
    const timeline = parseTimeline({ version: 1, clips: [{ id: "a", assetId: p1.id, kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 }, { id: "b", assetId: p2.id, kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 }], texts: [], music: null });
    const reel = await prisma.reel.create({ data: { workspaceId: workspace.id, title: "Fit", timeline: timeline as any } });

    // The worker: on the first wait, it speaks the line, keeps the asset and marks the step done.
    let worked = false;
    const sleep = async () => {
      if (worked) return;
      worked = true;
      const step = await prisma.workflowStep.findFirstOrThrow({ where: { run: { workspaceId: workspace.id, kind: "voiceover" } } });
      const asset = await prisma.mediaAsset.create({ data: { workspaceId: workspace.id, kind: "AUDIO", objectKey: `workspaces/${workspace.id}/voiceover/${step.id}.mp3`, contentType: "audio/mpeg", fileName: "Voiceover.mp3", sizeBytes: 4000n, durationMs: 1800, transcript } });
      await prisma.workflowStep.update({ where: { id: step.id }, data: { status: "SUCCEEDED", result: { assetId: asset.id, durationMs: 1800, transcript } } });
    };
    const deps = { start: startWorkerStepRun, step: (id: string) => prisma.workflowStep.findUnique({ where: { id }, select: { status: true, result: true, error: true } }), sleep };

    const added = await addVoiceover({ id: user.id, workspaceId: workspace.id }, { reelId: reel.id, script: "Three bedrooms and a garden.", voice: "aura-2:theia" }, deps);
    expect(added).toMatchObject({ ok: true, revision: 1, shortByMs: 0 });
    const run1 = await prisma.workflowRun.findFirstOrThrow({ where: { workspaceId: workspace.id, kind: "voiceover" } });
    expect(run1.requestId).toBe(voiceoverRequestId(reel.id, "Three bedrooms and a garden.", "aura-2:theia"));
    // Its message went through the outbox, like every other worker step.
    const step = await prisma.workflowStep.findFirstOrThrow({ where: { runId: run1.id } });
    expect(await prisma.outboxMessage.count({ where: { body: { contains: step.id } } })).toBe(1);

    const saved = await prisma.reel.findUniqueOrThrow({ where: { id: reel.id } });
    const after = parseTimeline(saved.timeline);
    expect(saved.revision).toBe(1);
    expect(after.voiceover).toMatchObject({ voice: "aura-2:theia", script: "Three bedrooms and a garden.", atMs: 0 });
    expect(after.texts.filter((text) => text.id.startsWith("vo-")).map((text) => text.text).join(" ")).toBe(transcript.text);

    // The same line again reuses the finished step: nothing new is queued, and setting it again changes nothing.
    const again = await addVoiceover({ id: user.id, workspaceId: workspace.id }, { reelId: reel.id, script: "Three bedrooms and a garden.", voice: "aura-2:theia" }, deps);
    expect(again).toMatchObject({ ok: true, revision: 1 });
    expect(await prisma.workflowRun.count({ where: { workspaceId: workspace.id, kind: "voiceover" } })).toBe(1);
  });
});
