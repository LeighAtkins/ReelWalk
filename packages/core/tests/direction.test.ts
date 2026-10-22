import { describe, expect, it } from "vitest";
import { aiDirectionSchema, directionPrompt, directionStill, hasDirection, PERFORMANCE_MAX_MS } from "../src/direction";
import { aiShotPrompt, aiShotSchema } from "../src/ai-shots";
import { defaultFraming, escalateFraming, FRAMING_FACE_PX, feetInFrame, framingInstruction, plateCropRect, speakingFraming } from "../src/presenter";

describe("framing before compose (ADR 0069)", () => {
  it("crops the plate for close and tight, centred and a little low so the floor stays in, never for medium or wide", () => {
    expect(plateCropRect("medium")).toEqual({ x: 0, y: 0, width: 1080, height: 1920, zoom: 1 });
    expect(plateCropRect("wide").zoom).toBe(1);
    const close = plateCropRect("close");
    expect(close).toEqual({ x: 203, y: 475, width: 674, height: 1200, zoom: 1.6 });
    expect(close.y + close.height / 2).toBeCloseTo(0.56 * 1920, -1);
    const tight = plateCropRect("tight");
    expect(tight.zoom).toBe(2.25);
    expect(tight.width).toBe(480); expect(tight.height).toBe(852);
    expect(tight.x + tight.width / 2).toBe(540);
    expect(tight.y + tight.height).toBeLessThanOrEqual(1920);
    // Even sizes, so the encoder never pads a scene by a pixel.
    for (const framing of ["close", "tight"] as const) { const rect = plateCropRect(framing); expect(rect.width % 2).toBe(0); expect(rect.height % 2).toBe(0); }
  });

  it("aims a face of at least 300 px close and 420 px tight, and says so to the image model", () => {
    expect(FRAMING_FACE_PX.close).toBe(300); expect(FRAMING_FACE_PX.tight).toBe(420);
    expect(framingInstruction("close")).toContain("320 px");
    expect(framingInstruction("tight")).toContain("440 px");
    expect(framingInstruction("medium")).toContain("180 px");
    expect(feetInFrame("close")).toBe(false); expect(feetInFrame("medium")).toBe(true);
  });

  it("defaults a spoken line to close, a silent one to medium, and a described wide to wide", () => {
    expect(defaultFraming(["By the island bench."], true)).toBe("close");
    expect(defaultFraming(["By the island bench."], false)).toBe("medium");
    expect(defaultFraming(["Wide: a figure on the drive."], true)).toBe("wide");
    const shot = (extra: Record<string, unknown>) => aiShotSchema.parse({ mode: "custom", first: { assetId: "room", atMs: 0 }, compose: { presenterId: "kit", first: "Beside the island bench, waist above it." }, ...extra });
    expect(shot({}).compose?.framing).toBe("medium");
    expect(shot({ line: "Welcome home.", voice: "veo" }).compose?.framing).toBe("close");
    expect(shot({ line: "Welcome home.", voice: "veo", compose: { presenterId: "kit", first: "At the gate.", framing: "tight" } }).compose?.framing).toBe("tight");
  });

  it("composes a speaking end at least close and escalates one step after a face too small", () => {
    expect(speakingFraming("medium")).toBe("close"); expect(speakingFraming("wide")).toBe("close"); expect(speakingFraming("tight")).toBe("tight");
    expect(escalateFraming("wide")).toBe("close"); expect(escalateFraming("medium")).toBe("close"); expect(escalateFraming("close")).toBe("tight"); expect(escalateFraming("tight")).toBe("tight");
  });
});

describe("direction (ADR 0069)", () => {
  it("accepts tone, energy, eye line, blocking and a reference of at most three seconds", () => {
    expect(aiDirectionSchema.safeParse({ tone: "dry", energy: "still", eyeLine: "off-left", blocking: "lean-in" }).success).toBe(true);
    expect(aiDirectionSchema.safeParse({ tone: "sarcastic" }).success).toBe(false);
    expect(aiDirectionSchema.safeParse({ performance: { assetId: "clip", fromMs: 1000, toMs: 1000 + PERFORMANCE_MAX_MS } }).success).toBe(true);
    expect(aiDirectionSchema.safeParse({ performance: { assetId: "clip", fromMs: 1000, toMs: 1000 + PERFORMANCE_MAX_MS + 1 } }).success).toBe(false);
    expect(hasDirection({})).toBe(false); expect(hasDirection({ tone: "dry" })).toBe(true); expect(hasDirection(undefined)).toBe(false);
  });

  it("turns each choice into physical instructions for Veo, the reference description last", () => {
    const prompt = directionPrompt({ tone: "dry", energy: "still", eyeLine: "off-right", blocking: "turn-to-object", object: "the pool", performance: { assetId: "ref", fromMs: 0, toMs: 2000, description: "a slow shrug, eyebrows up" } });
    expect(prompt).toContain("unsmiling"); expect(prompt).toContain("never grins");
    expect(prompt).toContain("completely still");
    expect(prompt).toContain("to her right, past the camera"); expect(prompt).toContain("never into the lens");
    expect(prompt).toContain("turned toward the pool");
    expect(prompt.endsWith("Match the delivery of this reference performance: a slow shrug, eyebrows up")).toBe(true);
    expect(directionPrompt({})).toBe("");
    expect(directionPrompt({ blocking: "step-back-reveal" })).toContain("revealing the room behind her");
  });

  it("puts the expression and the pose into the composed still, with different first and last poses for moving blocking", () => {
    expect(directionStill({ tone: "dry", eyeLine: "lens" }, "first")).toBe("Her expression is neutral and unsmiling, lips closed and level, eyebrows relaxed. Her eyes look straight into the lens.");
    expect(directionStill({ blocking: "walk-in-left" }, "first")).toContain("mid-stride at the left edge");
    expect(directionStill({ blocking: "walk-in-left" }, "last")).toContain("on her mark");
    expect(directionStill({ blocking: "step-back-reveal", object: "the view" }, "first")).toContain("very close to the lens");
    expect(directionStill({ blocking: "step-back-reveal", object: "the view" }, "last")).toContain("the view is clear behind her");
    expect(directionStill({ blocking: "stand" }, "first")).toBe("");
  });

  it("rides along in the shot and is the last thing the Veo prompt says", () => {
    const shot = aiShotSchema.parse({ mode: "wide-walk", first: { assetId: "room", atMs: 0 }, line: "Cosy. It is small.", voice: "veo", direction: { tone: "dry", blocking: "stand" } });
    expect(shot.direction).toEqual({ tone: "dry", blocking: "stand" });
    const prompt = aiShotPrompt("wide-walk", "Keep the room as it is.", shot);
    expect(prompt.endsWith("Keep the room as it is. Deadpan delivery: her face stays flat and unsmiling for the whole take, lips level and closed between phrases, eyebrows still; she never grins or laughs. A flat, even voice with no lift at the end of a sentence. She stays on her mark for the whole take.")).toBe(true);
    expect(aiShotPrompt("wide-walk", "Keep the room as it is.", aiShotSchema.parse({ mode: "wide-walk", first: { assetId: "room", atMs: 0 } })).endsWith("Keep the room as it is.")).toBe(true);
  });
});
