import { describe, expect, it } from "vitest";
import { acceptFor, inputFilenameFor, outputKeyFor, resolveUploadType, thumbKeyFor, uploadKeyFor } from "../src";

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

  it("accepts music", () => {
    expect(resolveUploadType("audio/mpeg", "song.mp3")).toEqual({ contentType: "audio/mpeg", extension: "mp3", kind: "AUDIO" });
    expect(resolveUploadType("application/octet-stream", "track.M4A")?.kind).toBe("AUDIO");
  });

  it("builds accept lists per kind", () => {
    expect(acceptFor(["AUDIO"])).toBe("audio/mpeg,audio/mp4,audio/x-m4a,audio/aac,audio/wav,audio/x-wav");
    expect(acceptFor(["IMAGE"])).toBe("image/jpeg,image/png,image/webp");
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

  it("puts thumbnails beside uploads", () => {
    expect(thumbKeyFor("uploads/ws-1/asset-1.mov")).toBe("thumbs/ws-1/asset-1.jpg");
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
