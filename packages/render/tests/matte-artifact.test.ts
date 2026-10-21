import { describe, expect, it } from "vitest";
import { checkManifest, MATTE_ARTIFACTS_ENABLED, matteArtifactPrefix, matteFrameKey, sourceFrameIndex, subjectHash, type MatteManifest } from "../src/reel/matte-artifact";
import { MATTE_VERSION } from "../src/reel/matte-core";

const sha = "a".repeat(64);
const taps = { kind: "object" as const, taps: [{ x: 0.5, y: 0.4 }], pin: { fromMs: 200, quad: [0.1, 0.2, 0.8, 0.2, 0.8, 0.5, 0.1, 0.5], path: [[0.1, 0.2, 0.8, 0.2, 0.8, 0.5, 0.1, 0.5]] } };

describe("matte artifacts, the end state (ADR 0051)", () => {
  it("is off until the worker produces them", () => {
    expect(MATTE_ARTIFACTS_ENABLED).toBe(false);
  });

  it("keys artifacts by source hash, version and subject, never by anything mutable", () => {
    expect(matteArtifactPrefix(sha, { kind: "person" })).toBe(`mattes/${sha}/${MATTE_VERSION}/person`);
    const prefix = matteArtifactPrefix(sha, taps);
    expect(prefix).toMatch(new RegExp(`^mattes/${sha}/${MATTE_VERSION}/object-[0-9a-f]{16}$`));
    expect(matteFrameKey(prefix, 42)).toBe(`${prefix}/frames/000042.png`);
    expect(() => matteArtifactPrefix("not-a-hash", { kind: "person" })).toThrow(/sha256/);
    // Float noise below the stored precision is the same subject; a moved tap is not.
    expect(subjectHash({ ...taps, taps: [{ x: 0.5000000001, y: 0.4 }] })).toBe(subjectHash(taps));
    expect(subjectHash({ ...taps, taps: [{ x: 0.51, y: 0.4 }] })).not.toBe(subjectHash(taps));
  });

  it("maps a composition frame to the source frame the footage shows", () => {
    const manifest = { source: { sha256: sha, width: 1080, height: 1920, fps: 30, frameCount: 90 } };
    expect(sourceFrameIndex(manifest, { sourceStartMs: 0 }, 0, 30)).toBe(0);
    expect(sourceFrameIndex(manifest, { sourceStartMs: 1000 }, 15, 30)).toBe(45);
    expect(sourceFrameIndex(manifest, { sourceStartMs: 1000, speed: 1.5 }, 10, 30)).toBe(45);
    expect(sourceFrameIndex(manifest, { sourceStartMs: 2900 }, 30, 30)).toBe(89);
  });

  it("refuses a manifest from another version, source or tap set", () => {
    const manifest: MatteManifest = {
      format: 1, matteVersion: MATTE_VERSION, subject: "person",
      source: { sha256: sha, width: 1080, height: 1920, fps: 30, frameCount: 2 },
      mask: { width: 540, height: 960 }, frames: ["b".repeat(64), "c".repeat(64)],
    };
    expect(checkManifest(manifest, { sourceSha256: sha, subject: { kind: "person" } }).frames).toHaveLength(2);
    expect(() => checkManifest({ ...manifest, matteVersion: "matte-0-old" }, { sourceSha256: sha, subject: { kind: "person" } })).toThrow(/this renderer draws/);
    expect(() => checkManifest(manifest, { sourceSha256: "d".repeat(64), subject: { kind: "person" } })).toThrow(/different source/);
    expect(() => checkManifest(manifest, { sourceSha256: sha, subject: taps })).toThrow(/different taps/);
    expect(() => checkManifest({ ...manifest, frames: ["b".repeat(64)] }, { sourceSha256: sha, subject: { kind: "person" } })).toThrow();
  });
});
