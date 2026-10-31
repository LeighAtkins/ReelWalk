import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAttemptScope } from "../src/lifecycle";

// The voiceover step (ADR 0099) with the voice Worker, the speech model, storage and the database stood in for.
const { db, sent, spoken, heard } = vi.hoisted(() => ({
  db: { mediaAsset: { upsert: vi.fn() } },
  sent: [] as { name: string; input: { Key?: string; ContentType?: string; ContentLength?: number } }[],
  spoken: vi.fn(),
  heard: vi.fn(),
}));
vi.mock("@reelwalk/db", () => ({ prisma: db }));
vi.mock("../src/library/tools", () => ({
  s3: { send: vi.fn(async (command: { constructor: { name: string }; input: { Key?: string } }) => (sent.push({ name: command.constructor.name, input: command.input }), {})) },
  run: vi.fn(async () => ({ stdout: "2.84\n", stderr: "" })),
}));
vi.mock("../src/transcribe", () => ({ transcribeVideo: heard }));
vi.mock("../src/voice", async (original) => ({ ...(await original<typeof import("../src/voice")>()), synthesiseLine: spoken }));
import { runVoiceoverStep, voiceoverKey } from "../src/voiceover";

const words = { text: "Three bedrooms and a garden.", words: [{ w: "Three", s: 0, e: 300 }, { w: "bedrooms", s: 320, e: 900 }] };

beforeEach(() => {
  sent.length = 0;
  vi.stubEnv("VOICE_ENABLED", "true");
  vi.stubEnv("VOICE_TTS_URL", "https://voice");
  vi.stubEnv("VOICE_TTS_KEY", "k");
  spoken.mockReset().mockResolvedValue(Buffer.alloc(4000, 1));
  heard.mockReset().mockResolvedValue(words);
  db.mediaAsset.upsert.mockReset().mockResolvedValue({ id: "vo-asset" });
});
afterEach(() => vi.unstubAllEnvs());

describe("voiceover step", () => {
  it("speaks the script in the chosen voice, transcribes it, stores it under the step and keeps it as an AUDIO asset", async () => {
    const scope = createAttemptScope();
    try {
      const result = await runVoiceoverStep({ id: "step1", payload: { script: "Three bedrooms and a garden.", voice: "aura-2:hyperion" }, user: { workspaceId: "w1" } }, scope);
      expect(result).toEqual({ assetId: "vo-asset", durationMs: 2840, transcript: words });
    } finally {
      await scope.close();
    }
    expect(spoken).toHaveBeenCalledWith("Three bedrooms and a garden.", { model: "aura-2", speaker: "hyperion" });
    expect(sent).toEqual([{ name: "PutObjectCommand", input: expect.objectContaining({ Key: voiceoverKey("w1", "step1"), ContentType: "audio/mpeg", ContentLength: 4000 }) }]);
    const upsert = db.mediaAsset.upsert.mock.calls[0][0];
    // Keyed by the object, so a retried attempt writes the same row.
    expect(upsert.where).toEqual({ objectKey: "workspaces/w1/voiceover/step1.mp3" });
    expect(upsert.create).toMatchObject({ workspaceId: "w1", kind: "AUDIO", contentType: "audio/mpeg", durationMs: 2840, transcript: words });
    expect(upsert.create.attribution).toContain("AI voice");
  });

  it("keeps the voiceover when nothing is recognised in it; the captions are just left off", async () => {
    heard.mockResolvedValue(null);
    const scope = createAttemptScope();
    try {
      expect(await runVoiceoverStep({ id: "s2", payload: { script: "Hi.", voice: "aura-2:theia" }, user: { workspaceId: "w1" } }, scope)).toMatchObject({ assetId: "vo-asset", transcript: null });
    } finally {
      await scope.close();
    }
  });

  it("refuses a voice that is not offered, a script that is too long, and a server without the voice service", async () => {
    const scope = createAttemptScope();
    try {
      await expect(runVoiceoverStep({ id: "s3", payload: { script: "Hi.", voice: "aura-2:nobody" }, user: { workspaceId: "w1" } }, scope)).rejects.toThrow();
      await expect(runVoiceoverStep({ id: "s3", payload: { script: "x".repeat(401), voice: "aura-2:theia" }, user: { workspaceId: "w1" } }, scope)).rejects.toThrow();
      vi.stubEnv("VOICE_ENABLED", "false");
      await expect(runVoiceoverStep({ id: "s3", payload: { script: "Hi.", voice: "aura-2:theia" }, user: { workspaceId: "w1" } }, scope)).rejects.toThrow(/not set up/);
    } finally {
      await scope.close();
    }
    expect(spoken).not.toHaveBeenCalled();
  });
});
