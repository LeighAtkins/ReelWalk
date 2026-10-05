import { describe, expect, it } from "vitest";
import { inputFilenameFor, outputKeyFor, resolveUploadType, uploadKeyFor } from "../src";

describe("resolveUploadType", () => {
  it("keeps image and video extensions", () => {
    expect(resolveUploadType("video/mp4", "walk.mp4")).toEqual({ contentType: "video/mp4", extension: "mp4", kind: "VIDEO" });
    expect(resolveUploadType("image/jpeg", "pano.jpg")).toEqual({ contentType: "image/jpeg", extension: "jpg", kind: "IMAGE" });
    expect(resolveUploadType("video/quicktime; codecs=avc1", "walk.mov")?.extension).toBe("mov");
  });

  it("falls back to the filename for octet-stream", () => {
    expect(resolveUploadType("application/octet-stream", "pano.JPEG")).toEqual({
      contentType: "image/jpeg",
      extension: "jpeg",
      kind: "IMAGE",
    });
    expect(resolveUploadType("", "walk.mp4")?.contentType).toBe("video/mp4");
  });

  it("rejects unsupported uploads", () => {
    expect(resolveUploadType("application/octet-stream", "mystery.bin")).toBeNull();
    expect(resolveUploadType("text/plain", "notes.txt")).toBeNull();
    expect(resolveUploadType(undefined, undefined)).toBeNull();
  });
});

describe("object keys", () => {
  it("builds upload keys under the property", () => {
    expect(uploadKeyFor("prop-1", "asset-1", "jpg")).toBe("uploads/prop-1/asset-1.jpg");
  });

  it("derives the output key from the job id alone", () => {
    expect(outputKeyFor("job-1")).toBe("renders/job-1.mp4");
  });

  it("preserves the input extension so images are not treated as video", () => {
    expect(inputFilenameFor("uploads/p/x.JPG")).toBe("input.jpg");
    expect(inputFilenameFor("uploads/p/x.mov")).toBe("input.mov");
    expect(inputFilenameFor("uploads/p/noext")).toBe("input.mp4");
    expect(inputFilenameFor("uploads/p/x.exe")).toBe("input.mp4");
  });
});
