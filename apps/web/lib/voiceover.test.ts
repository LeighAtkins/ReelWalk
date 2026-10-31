/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCommand, parseTimeline, timelineDurationMs, type Command, type Timeline } from "@reelwalk/core";

const reels = vi.hoisted(() => ({ current: null as any, saved: [] as Timeline[] }));
vi.mock("@reelwalk/db", () => ({ prisma: {} }));
vi.mock("./workflows", () => ({ startWorkerStepRun: vi.fn() }));
vi.mock("./reel-command", () => ({
  loadReel: async (_user: unknown, id: string) => (reels.current && reels.current.id === id ? { ...reels.current } : null),
  applyReelCommand: async (_user: unknown, loaded: any, command: Command) => {
    const result = applyCommand(loaded.timeline, command, { generation: loaded.revision });
    if (result.rejected) return { ok: false, status: 400, message: result.rejected, result };
    reels.saved.push(result.timeline);
    reels.current = { ...reels.current, timeline: result.timeline, revision: loaded.revision + 1 };
    return { ok: true, revision: loaded.revision + 1, result };
  },
}));

import { addVoiceover, voiceoverRequestId, VOICEOVER_TAIL_MS, type VoiceoverDeps } from "./voiceover";

const user = { id: "u1", workspaceId: "w1" };
const words = { text: "Three bedrooms and a garden.", words: [{ w: "Three", s: 0, e: 300 }, { w: "bedrooms", s: 320, e: 900 }, { w: "and", s: 950, e: 1050 }, { w: "a", s: 1060, e: 1100 }, { w: "garden.", s: 1120, e: 1700 }] };
const timeline = parseTimeline({ version: 1, clips: [{ id: "a", assetId: "p1", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 }, { id: "b", assetId: "p2", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 }], texts: [], music: null });

function deps(steps: { status: string; result?: unknown; error?: string | null }[]): VoiceoverDeps & { started: any[] } {
  const started: any[] = [];
  let polled = 0;
  return {
    started,
    start: (async (input: any) => (started.push(input), { ok: true, jobId: "step1", runId: "run1", resumed: false })) as any,
    step: async () => {
      const state = steps[Math.min(polled++, steps.length - 1)];
      return { status: state.status, result: state.result ?? null, error: state.error ?? null };
    },
    sleep: async () => undefined,
  };
}

beforeEach(() => {
  vi.stubEnv("VOICE_ENABLED", "true");
  reels.current = { id: "r1", title: "Fit", revision: 4, timeline, library: {}, brandKit: null };
  reels.saved = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("addVoiceover", () => {
  it("waits for the worker's step, then sets the voiceover with its captions as one revision", async () => {
    const d = deps([{ status: "QUEUED" }, { status: "RUNNING" }, { status: "SUCCEEDED", result: { assetId: "vo1", durationMs: 1800, transcript: words } }]);
    const added = await addVoiceover(user, { reelId: "r1", script: "  Three bedrooms   and a garden. ", voice: "aura-2:hyperion" }, d);
    expect(added).toMatchObject({ ok: true, revision: 5, assetId: "vo1", durationMs: 1800, lengthenedTo: null });
    expect(d.started[0]).toMatchObject({ kind: "voiceover", requestId: voiceoverRequestId("r1", "Three bedrooms and a garden.", "aura-2:hyperion"), payload: { script: "Three bedrooms and a garden.", voice: "aura-2:hyperion" } });
    const saved = reels.saved[0];
    expect(saved.voiceover).toEqual({ assetId: "vo1", atMs: 0, volume: 1, script: "Three bedrooms and a garden.", voice: "aura-2:hyperion" });
    expect(saved.texts.filter((text) => text.id.startsWith("vo-")).length).toBeGreaterThan(0);
    expect(added.ok && added.captions).toBeGreaterThan(0);
  });

  it("lengthens a reel the voiceover would outrun, in the same revision", async () => {
    const added = await addVoiceover(user, { reelId: "r1", script: "A long line.", atMs: 1000 }, deps([{ status: "SUCCEEDED", result: { assetId: "vo1", durationMs: 7000, transcript: words } }]));
    expect(added).toMatchObject({ ok: true, revision: 5, shortByMs: 0 });
    expect(reels.saved).toHaveLength(1);
    expect(timelineDurationMs(reels.saved[0])).toBeGreaterThanOrEqual(8000 + VOICEOVER_TAIL_MS);
    expect(added.ok && added.lengthenedTo).toBe(timelineDurationMs(reels.saved[0]));
  });

  it("says how far a voiceover still runs past the end when the shots cannot stretch that far", async () => {
    const added = await addVoiceover(user, { reelId: "r1", script: "A very long line.", atMs: 0 }, deps([{ status: "SUCCEEDED", result: { assetId: "vo1", durationMs: 12_000, transcript: words } }]));
    // Two photos stretch to 5 s each at most.
    expect(added).toMatchObject({ ok: true, lengthenedTo: 10_000, shortByMs: 12_000 + VOICEOVER_TAIL_MS - 10_000 });
  });

  it("keeps the voiceover without captions when nothing was recognised, or when captions are off", async () => {
    await addVoiceover(user, { reelId: "r1", script: "Hello there." }, deps([{ status: "SUCCEEDED", result: { assetId: "vo1", durationMs: 1000, transcript: null } }]));
    expect(reels.saved[0].voiceover?.voice).toBe("aura-2:theia");
    expect(reels.saved[0].texts).toEqual([]);
    reels.current = { ...reels.current, timeline };
    await addVoiceover(user, { reelId: "r1", script: "Hello there.", captions: false }, deps([{ status: "SUCCEEDED", result: { assetId: "vo1", durationMs: 1000, transcript: words } }]));
    expect(reels.saved[1].texts).toEqual([]);
  });

  it("answers with the reason when the step fails or is still running, and saves nothing", async () => {
    expect(await addVoiceover(user, { reelId: "r1", script: "Hello there." }, deps([{ status: "FAILED", error: "The voice service returned HTTP 502." }]))).toMatchObject({ ok: false, status: 502, message: expect.stringContaining("HTTP 502") });
    expect(await addVoiceover(user, { reelId: "r1", script: "Hello there.", waitMs: 0 }, deps([{ status: "RUNNING" }]))).toMatchObject({ ok: false, status: 504 });
    // No answer for the paid request: said plainly, with the way to a new line, and nothing saved.
    expect(await addVoiceover(user, { reelId: "r1", script: "Hello there." }, deps([{ status: "UNRESOLVED", error: "unresolved" }]))).toMatchObject({ ok: false, status: 502, message: expect.stringContaining("never paid for twice") });
    expect(reels.saved).toEqual([]);
  });

  it("refuses without the voice service, a voice not offered, a script too long and a reel not in the account", async () => {
    const d = deps([{ status: "SUCCEEDED" }]);
    expect(await addVoiceover(user, { reelId: "r1", script: "Hello there.", voice: "aura-2:nobody" }, d)).toMatchObject({ ok: false, status: 400 });
    expect(await addVoiceover(user, { reelId: "r1", script: "x".repeat(401) }, d)).toMatchObject({ ok: false, status: 400 });
    expect(await addVoiceover(user, { reelId: "r9", script: "Hello there." }, d)).toMatchObject({ ok: false, status: 404 });
    vi.stubEnv("VOICE_ENABLED", "false");
    expect(await addVoiceover(user, { reelId: "r1", script: "Hello there." }, d)).toMatchObject({ ok: false, status: 503 });
    expect(d.started).toEqual([]);
  });
});
