import { describe, expect, it } from "vitest";
import { MATTE_ARTIFACT_FORMAT, matteManifestSchema } from "../src/reel/matte-artifact";

// The render package moved from zod 3 to zod 4 (CVE-2023-54404): the manifest it reads from disk must parse the same.
const hash = (n: number) => n.toString(16).padStart(64, "0");
const manifest = {
  format: MATTE_ARTIFACT_FORMAT,
  matteVersion: "m1",
  subject: "person",
  source: { sha256: hash(255), width: 1080, height: 1920, fps: 30, frameCount: 2 },
  mask: { width: 270, height: 480 },
  frames: [hash(1), hash(2)],
};

describe("matteManifestSchema", () => {
  it("accepts a manifest with one hash per source frame and keeps status optional", () => {
    expect(matteManifestSchema.parse(manifest)).toEqual(manifest);
    expect(matteManifestSchema.parse({ ...manifest, status: ["tracked", "wall"] }).status).toEqual(["tracked", "wall"]);
  });

  it("refuses a frame count that does not match, a bad hash and a wrong format", () => {
    expect(matteManifestSchema.safeParse({ ...manifest, frames: [hash(1)] }).success).toBe(false);
    expect(matteManifestSchema.safeParse({ ...manifest, frames: [hash(1), "nothex"] }).success).toBe(false);
    expect(matteManifestSchema.safeParse({ ...manifest, format: MATTE_ARTIFACT_FORMAT + 1 }).success).toBe(false);
  });
});
