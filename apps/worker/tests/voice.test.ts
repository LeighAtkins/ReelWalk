import { afterEach, describe, expect, it, vi } from "vitest";
import { lipsyncRequest, lipsyncStatus, presenterVoice, synthesiseLine, ttsAudio, ttsRequest, voicedPrompt } from "../src/voice";

describe("presenter voice", () => {
  it("builds the voice Worker request for the configured voice", () => {
    expect(ttsRequest(presenterVoice("melotts:en"), "Worth dropping in.", "https://voice")).toEqual({ url: "https://voice", body: { text: "Worth dropping in.", voice: "melotts:en" } });
    expect(ttsRequest(presenterVoice("aura-1:luna"), "Hi", "https://voice")).toEqual({ url: "https://voice", body: { text: "Hi", voice: "aura-1:luna" } });
    expect(presenterVoice(undefined as never)).toEqual({ model: "melotts", lang: "en" });
  });

  it("reads audio whether it comes raw or wrapped in JSON", async () => {
    const raw = { headers: { get: () => "audio/mpeg" }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, json: async () => ({}) };
    expect([...await ttsAudio(raw)]).toEqual([1, 2, 3]);
    const wrapped = { headers: { get: () => "application/json" }, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({ result: { audio: Buffer.from("abc").toString("base64") } }) };
    expect((await ttsAudio(wrapped)).toString()).toBe("abc");
    await expect(ttsAudio({ ...wrapped, json: async () => ({ result: {} }) })).rejects.toThrow("no audio");
  });

  it("asks sync.so to keep the take's length and reads its status", () => {
    expect(lipsyncRequest("https://v", "https://a", "lipsync-2")).toEqual({ model: "lipsync-2", input: [{ type: "video", url: "https://v" }, { type: "audio", url: "https://a" }], options: { sync_mode: "bounce" } });
    expect(lipsyncStatus({ status: "PROCESSING" })).toEqual({ done: false });
    expect(lipsyncStatus({ status: "COMPLETED", outputUrl: "https://out" })).toEqual({ done: true, url: "https://out" });
    expect(lipsyncStatus({ status: "FAILED", error: "bad face" })).toEqual({ done: true, error: "bad face" });
  });

  it("writes the line into the Veo prompt for each voice mode", () => {
    expect(voicedPrompt("She lands.", "Who needs a front door?", "veo")).toContain('says aloud');
    expect(voicedPrompt("She lands.", "Who needs a front door?", "lipsync")).toContain("mouth moving naturally");
  });

  it("does not override a studio's American accent or conversational delivery", () => {
    const direction = "Neutral General American accent. Speak casually to a friend and point left.";
    const prompt = voicedPrompt(direction, "See how these dots pull focus?", "veo");
    expect(prompt).toContain(direction);
    expect(prompt).toContain('"See how these dots pull focus?"');
    expect(prompt).toContain("voice, accent and delivery specified in the direction");
    expect(prompt).not.toContain("Australian");
  });
});

// ADR 0100: what actually goes to the voice Worker for a take's chosen voice, with the key handled as before.
describe("synthesiseLine", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it("sends the chosen voice to the voice Worker, and the configured presenter voice when none is chosen", async () => {
    vi.stubEnv("VOICE_TTS_URL", "https://voice.example/speak"); vi.stubEnv("VOICE_TTS_KEY", "test-key"); vi.stubEnv("PRESENTER_VOICE", "melotts:en");
    const sent: { url: string; key: string | null; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, key: new Headers(init.headers).get("x-voice-key"), body: JSON.parse(String(init.body)) });
      return new Response(new Uint8Array(200), { headers: { "content-type": "audio/mpeg" } });
    }));
    await synthesiseLine("Nice room, right?", presenterVoice("aura-2:theia"));
    await synthesiseLine("Nice room, right?", presenterVoice("aura-2:hyperion"));
    await synthesiseLine("Nice room, right?");
    expect(sent.map((request) => request.body)).toEqual([
      { text: "Nice room, right?", voice: "aura-2:theia" },
      { text: "Nice room, right?", voice: "aura-2:hyperion" },
      { text: "Nice room, right?", voice: "melotts:en" },
    ]);
    expect(sent.every((request) => request.url === "https://voice.example/speak" && request.key === "test-key")).toBe(true);
  });
});
