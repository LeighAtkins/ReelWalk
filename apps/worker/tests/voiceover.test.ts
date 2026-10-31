import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAttemptScope } from "../src/lifecycle";

// The voiceover step (ADR 0099) with the voice Worker, the speech model, storage and the database stood in for.
// Storage keeps what was put across attempts, as S3 does, so an attempt can fail after the audio is saved and the
// next one can be watched finding it.
const { db, store, events, spoken, heard, probe } = vi.hoisted(() => ({
  db: { mediaAsset: { upsert: vi.fn() } },
  store: new Map<string, { body: Buffer; metadata: Record<string, string> }>(),
  events: [] as string[],
  spoken: vi.fn(),
  heard: vi.fn(),
  probe: vi.fn(),
}));
const puts = vi.hoisted(() => ({ failures: 0 }));
vi.mock("@reelwalk/db", () => ({ prisma: db }));
vi.mock("../src/library/tools", () => ({
  s3: {
    send: vi.fn(async (command: { constructor: { name: string }; input: { Key: string; Body?: Buffer; Metadata?: Record<string, string> } }) => {
      const { Key } = command.input;
      if (command.constructor.name === "GetObjectCommand") {
        events.push("get");
        const found = store.get(Key);
        if (!found) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
        return { Body: { transformToByteArray: async () => new Uint8Array(found.body) }, Metadata: found.metadata };
      }
      events.push("put");
      if (puts.failures > 0) {
        puts.failures--;
        throw new Error("S3 is having a moment");
      }
      store.set(Key, { body: Buffer.from(command.input.Body!), metadata: command.input.Metadata ?? {} });
      return {};
    }),
  },
  run: (...args: unknown[]) => probe(...args),
}));
vi.mock("../src/transcribe", () => ({ transcribeVideo: (...args: unknown[]) => heard(...args) }));
vi.mock("../src/voice", async (original) => ({ ...(await original<typeof import("../src/voice")>()), synthesiseLine: (...args: unknown[]) => spoken(...args) }));
import { VoiceServiceAnswered } from "../src/voice";
import { runVoiceoverStep, voiceoverKey } from "../src/voiceover";

const words = { text: "Three bedrooms and a garden.", words: [{ w: "Three", s: 0, e: 300 }, { w: "bedrooms", s: 320, e: 900 }] };
const line = { script: "Three bedrooms and a garden.", voice: "aura-2:hyperion" };
const AUDIO = Buffer.alloc(4000, 7);

function gate() {
  const calls = { before: 0, answered: 0 };
  return {
    calls,
    beforeRequest: vi.fn(async () => { events.push("submitted"); calls.before++; }),
    answered: vi.fn(() => { events.push("answered"); calls.answered++; }),
  };
}

/** One attempt in its own scope, as the worker runs it. */
async function attempt(g = gate(), stepId = "step1", payload: unknown = line) {
  const scope = createAttemptScope();
  try {
    return await runVoiceoverStep({ id: stepId, payload, user: { workspaceId: "w1" } }, scope, g, () => undefined);
  } finally {
    await scope.close();
  }
}

beforeEach(() => {
  store.clear();
  events.length = 0;
  puts.failures = 0;
  vi.stubEnv("VOICE_ENABLED", "true");
  vi.stubEnv("VOICE_TTS_URL", "https://voice");
  vi.stubEnv("VOICE_TTS_KEY", "k");
  spoken.mockReset().mockImplementation(async () => { events.push("spoken"); return AUDIO; });
  heard.mockReset().mockImplementation(async () => { events.push("transcribed"); return words; });
  probe.mockReset().mockImplementation(async () => { events.push("probed"); return { stdout: "2.84\n", stderr: "" }; });
  db.mediaAsset.upsert.mockReset().mockImplementation(async () => { events.push("asset"); return { id: "vo-asset" }; });
});
afterEach(() => vi.unstubAllEnvs());

describe("voiceover step", () => {
  it("records the submission, speaks once, saves the audio with its checksum before transcribing, and keeps it as an AUDIO asset", async () => {
    const g = gate();
    expect(await attempt(g)).toEqual({ assetId: "vo-asset", durationMs: 2840, transcript: words });
    expect(spoken).toHaveBeenCalledWith(line.script, { model: "aura-2", speaker: "hyperion" }, expect.any(AbortSignal));
    expect(g.calls).toEqual({ before: 1, answered: 1 });
    // Looked for first; the request only after the submission was recorded; the audio kept before anything that can fail after it.
    expect(events.slice(0, 5)).toEqual(["get", "submitted", "spoken", "answered", "put"]);
    const key = voiceoverKey("w1", line.voice, line.script);
    expect(store.get(key)?.metadata.sha256).toBe(createHash("sha256").update(AUDIO).digest("hex"));
    const upsert = db.mediaAsset.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ objectKey: key });
    expect(upsert.create).toMatchObject({ workspaceId: "w1", kind: "AUDIO", contentType: "audio/mpeg", durationMs: 2840, transcript: words });
    expect(upsert.create.attribution).toContain("AI voice");
  });

  it.each([
    ["transcription", () => heard.mockRejectedValueOnce(new Error("the speech model ran out of memory"))],
    ["probing", () => probe.mockRejectedValueOnce(new Error("ffprobe was killed"))],
    ["the asset row", () => db.mediaAsset.upsert.mockRejectedValueOnce(new Error("the database went away"))],
  ])("fails after the audio is saved (%s), and the next attempt reuses the audio without a request", async (_what, breakIt) => {
    breakIt();
    const first = gate();
    await expect(attempt(first)).rejects.toThrow();
    expect(first.calls).toEqual({ before: 1, answered: 1 });
    expect(store.has(voiceoverKey("w1", line.voice, line.script))).toBe(true);

    // A retry, or the owner asking again (a new generation of the step): the same line, found and reused.
    const second = gate();
    expect(await attempt(second, "step1")).toEqual({ assetId: "vo-asset", durationMs: 2840, transcript: words });
    expect(spoken).toHaveBeenCalledTimes(1);
    expect(second.calls).toEqual({ before: 0, answered: 0 });
  });

  it("reuses a line's audio for another step (another reel) in the workspace", async () => {
    await attempt(gate(), "step1");
    const other = gate();
    await attempt(other, "step2");
    expect(spoken).toHaveBeenCalledTimes(1);
    expect(other.calls.before).toBe(0);
  });

  it("speaks a different line, or the same line in another voice, afresh", async () => {
    await attempt(gate());
    await attempt(gate(), "step2", { ...line, voice: "aura-2:theia" });
    await attempt(gate(), "step3", { ...line, script: "Four bedrooms and a garden." });
    expect(spoken).toHaveBeenCalledTimes(3);
  });

  it("leaves a request with no answer in flight (the step is then unresolved), and saves nothing", async () => {
    spoken.mockRejectedValueOnce(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    const g = gate();
    await expect(attempt(g)).rejects.toThrow(/timeout/);
    expect(g.calls).toEqual({ before: 1, answered: 0 });
    expect(store.size).toBe(0);
  });

  it("counts an error answer from the voice service as answered (a definite failure, nothing made)", async () => {
    spoken.mockRejectedValueOnce(new VoiceServiceAnswered("The voice service returned HTTP 502."));
    const g = gate();
    await expect(attempt(g)).rejects.toThrow("HTTP 502");
    expect(g.calls).toEqual({ before: 1, answered: 1 });
    expect(store.size).toBe(0);
  });

  it("sends nothing when the gate refuses (the step was stopped or its lease lost)", async () => {
    const g = gate();
    g.beforeRequest.mockRejectedValueOnce(new Error("stopped"));
    await expect(attempt(g)).rejects.toThrow("stopped");
    expect(spoken).not.toHaveBeenCalled();
  });

  it("tries the save again before giving up on audio it has paid for", async () => {
    puts.failures = 2;
    await attempt(gate());
    expect(events.filter((event) => event === "put")).toHaveLength(3);
    expect(store.size).toBe(1);
    puts.failures = 3;
    store.clear();
    await expect(attempt(gate(), "step9", { ...line, script: "Another line entirely." })).rejects.toThrow("S3 is having a moment");
  });

  it("speaks the line again rather than trust saved audio that does not match its checksum", async () => {
    store.set(voiceoverKey("w1", line.voice, line.script), { body: Buffer.alloc(4000, 1), metadata: { sha256: "not-it" } });
    const g = gate();
    await attempt(g);
    expect(g.calls.before).toBe(1);
    expect(store.get(voiceoverKey("w1", line.voice, line.script))?.body.equals(AUDIO)).toBe(true);
  });

  it("keeps the voiceover when nothing is recognised in it; the captions are just left off", async () => {
    heard.mockResolvedValueOnce(null);
    expect(await attempt(gate(), "s2", { script: "Hi.", voice: "aura-2:theia" })).toMatchObject({ assetId: "vo-asset", transcript: null });
  });

  it("refuses a voice that is not offered, a script that is too long, and a server without the voice service", async () => {
    await expect(attempt(gate(), "s3", { script: "Hi.", voice: "aura-2:nobody" })).rejects.toThrow();
    await expect(attempt(gate(), "s3", { script: "x".repeat(401), voice: "aura-2:theia" })).rejects.toThrow();
    vi.stubEnv("VOICE_ENABLED", "false");
    await expect(attempt(gate(), "s3", { script: "Hi.", voice: "aura-2:theia" })).rejects.toThrow(/not set up/);
    expect(spoken).not.toHaveBeenCalled();
  });
});
