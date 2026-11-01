import { describe, expect, it } from "vitest";
import { omniConfigured, omniRequest, videoOf } from "../src/omni-video";

const jpeg = (tag: string) => ({ bytesBase64Encoded: tag, mimeType: "image/jpeg" });

describe("omniRequest", () => {
  it("sends the start and end frames as image parts before the prompt, at the asked resolution, in the background", () => {
    const body = omniRequest({ model: "gemini-omni-1.1-flash", prompt: "Fly through the arch.", resolution: "360p", durationSeconds: 8, image: jpeg("A"), lastFrame: jpeg("B") });
    expect(body).toEqual({
      model: "gemini-omni-1.1-flash",
      input: [
        { type: "image", data: "A", mime_type: "image/jpeg" },
        { type: "image", data: "B", mime_type: "image/jpeg" },
        { type: "text", text: "Fly through the arch. The clip is about 8 seconds long, vertical 9:16." },
      ],
      response_format: { type: "video", aspect_ratio: "9:16", resolution: "360p" },
      background: true,
      store: true,
    });
  });
  it("extends an earlier take by its interaction, with no frames", () => {
    const body = omniRequest({ model: "gemini-omni-1.1-flash", prompt: "Carry on into the bedroom.", resolution: "1080p", durationSeconds: 8, image: jpeg("A"), previousInteractionId: "v1_abc" });
    expect(body.previous_interaction_id).toBe("v1_abc");
    expect(typeof body.input).toBe("string");
  });
});

describe("videoOf", () => {
  it("finds the video in the model output step, inline or by uri", () => {
    const interaction = { id: "v1_x", status: "completed", steps: [{ type: "user_input" }, { type: "thought" }, { type: "model_output", content: [{ type: "video", mime_type: "video/mp4", data: "QUJD" }] }] };
    expect(videoOf(interaction)).toEqual({ data: "QUJD", mimeType: "video/mp4" });
    expect(videoOf({ steps: [{ type: "model_output", output: { type: "video", uri: "https://x/files/1:download?alt=media" } }] })).toEqual({ uri: "https://x/files/1:download?alt=media" });
    expect(videoOf({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "blocked" }] }] })).toBeNull();
  });
});

describe("omniConfigured", () => {
  it("treats Parameter Store's placeholder for an empty key as no key", () => {
    const before = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "unset";
    expect(omniConfigured()).toBe(false);
    process.env.GEMINI_API_KEY = "AIza-test";
    expect(omniConfigured()).toBe(true);
    if (before === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = before;
  });
});
