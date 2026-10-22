import { describe, expect, it } from "vitest";
import { aiShotSchema, parseStoredAiShot } from "../src/ai-shots";
import { CHAINED_REFERENCE_MESSAGE, PRESENTER_CROP_GAVE_UP, defaultFraming, presenterStatus, referenceDepthOf } from "../src/presenter";
import { DIRECTOR_INSTRUCTIONS, DIRECTOR_PLAN_JSON_SCHEMA } from "../src/ai-director";

const shot = (compose: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ mode: "custom", first: { assetId: "room", atMs: 0 }, compose, ...extra });
const first = "Beside the island bench, her waist just above it.";

describe("compose references (ADR 0056)", () => {
  it("rejects a generated take as the presenter, with the reason, unless explicitly allowed", () => {
    const chained = aiShotSchema.safeParse(shot({ presenter: { assetId: "ai-cmvgx1hlq", atMs: 0 }, first }));
    expect(chained.success).toBe(false);
    expect(chained.error?.issues.map(issue => issue.message)).toContain(CHAINED_REFERENCE_MESSAGE);
    expect(CHAINED_REFERENCE_MESSAGE).toBe("Pick the presenter kit, not a generated take — faces drift when takes are chained.");
    expect(aiShotSchema.safeParse(shot({ presenter: { assetId: "ai-cmvgx1hlq", atMs: 0 }, allowGeneratedReference: true, first })).success).toBe(true);
    expect(aiShotSchema.safeParse(shot({ presenter: { assetId: "real-upload", atMs: 0 }, first })).success).toBe(true);
    expect(aiShotSchema.safeParse(shot({ presenterId: "kit", first })).success).toBe(true);
    expect(aiShotSchema.safeParse(shot({ first })).success).toBe(false);
  });
  it("defaults composed stills to medium framing (close for a spoken line, ADR 0069) unless asked for or described as wide", () => {
    expect(aiShotSchema.parse(shot({ presenterId: "kit", first })).compose?.framing).toBe("medium");
    expect(aiShotSchema.parse(shot({ presenterId: "kit", first }, { line: "Welcome home.", voice: "lipsync" })).compose?.framing).toBe("close");
    expect(aiShotSchema.parse(shot({ presenterId: "kit", first: "Wide: a small figure walking up the drive." })).compose?.framing).toBe("wide");
    expect(aiShotSchema.parse(shot({ presenterId: "kit", first, framing: "wide" })).compose?.framing).toBe("wide");
    expect(defaultFraming([null, "Widely smiling at the bench."])).toBe("medium");
  });
  it("reads back an accepted pre-0056 row that named a generated take", () => {
    const stored = shot({ presenter: { assetId: "ai-old", atMs: 0 }, first }, { line: "Welcome home.", voice: "veo" });
    const parsed = parseStoredAiShot(stored);
    expect(parsed.success && parsed.data.voice).toBe("veo");
    expect(parseStoredAiShot(null).success).toBe(false);
  });
});

describe("reference lineage", () => {
  it("is 0 for the kit or real footage and one more than the source take for a generated take", () => {
    expect(referenceDepthOf({ kit: true })).toBe(0);
    expect(referenceDepthOf({ assetId: "upload-1", sourceDepth: null })).toBe(0);
    expect(referenceDepthOf({ assetId: "ai-a", sourceDepth: 0 })).toBe(1);
    // The villa chain: cmvf5ivdt → cmvf5truu → cmvgx1hlq.
    expect(referenceDepthOf({ assetId: "ai-cmvf5truu", sourceDepth: 2 })).toBe(3);
    expect(referenceDepthOf({ assetId: "ai-before-depths", sourceDepth: null })).toBe(1);
  });
});

describe("kit status", () => {
  it("is ready once the face crop exists, and says when the portrait's face is small", () => {
    expect(presenterStatus({ faceCropKey: null, faceCropError: null, faceHeightPx: null })).toEqual({ ready: false, label: "Preparing her face reference…" });
    expect(presenterStatus({ faceCropKey: null, faceCropError: "No clear face", faceHeightPx: null })).toEqual({ ready: false, label: "No clear face", canRetry: true });
    // Review P2: tries used up and the claim lapsed (the worker died on the last try) is a failure with Retry, not "Preparing".
    const now = new Date("2026-10-21T12:00:00Z");
    expect(presenterStatus({ faceCropKey: null, faceCropError: null, faceHeightPx: null, faceCropTries: 3, leaseUntil: new Date("2026-10-21T11:59:00Z") }, now)).toEqual({ ready: false, label: PRESENTER_CROP_GAVE_UP, canRetry: true });
    expect(presenterStatus({ faceCropKey: null, faceCropError: null, faceHeightPx: null, faceCropTries: 3, leaseUntil: new Date("2026-10-21T12:04:00Z") }, now).label).toBe("Preparing her face reference…");
    expect(presenterStatus({ faceCropKey: "k", faceCropError: null, faceHeightPx: 520 })).toEqual({ ready: true, label: "Ready" });
    expect(presenterStatus({ faceCropKey: "k", faceCropError: null, faceHeightPx: 100 }).label).toContain("100 px");
  });
});

describe("director rules", () => {
  it("tell Opus to use the kit, never a generated take, and medium framing for spoken lines", () => {
    expect(DIRECTOR_INSTRUCTIONS).toContain("presenter = null (the app uses the workspace's presenter kit");
    expect(DIRECTOR_INSTRUCTIONS).toContain("Never name an AI take");
    expect(DIRECTOR_INSTRUCTIONS).toContain("at least 180 px tall");
    const compose = DIRECTOR_PLAN_JSON_SCHEMA.properties.shots.items.properties.compose;
    expect(compose.required).toContain("framing");
  });
});
