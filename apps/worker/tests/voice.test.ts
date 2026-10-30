import { describe, expect, it } from "vitest";
import { lipsyncRequest, lipsyncStatus, presenterVoice, ttsAudio, ttsRequest, voicedPrompt } from "../src/voice";

describe("presenter voice", () => {
  it("builds the voice Worker request for the configured voice", () => {
    expect(ttsRequest(presenterVoice("melotts:en"), "Worth dropping in.", "https://voice")).toEqual({ url: "https://voice", body: { text: "Worth dropping in.", voice: "melotts:en" } });
    expect(ttsRequest(presenterVoice("aura-1:luna"), "Hi", "https://voice")).toEqual({ url: "https://voice", body: { text: "Hi", voice: "aura-1:luna" } });
    // Aura-2 English has the Australian presenter voice (theia); the voice Worker maps aura-2 to Workers AI's aura-2-en.
    expect(ttsRequest(presenterVoice("aura-2:theia"), "Hi", "https://voice")).toEqual({ url: "https://voice", body: { text: "Hi", voice: "aura-2:theia" } });
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
});
