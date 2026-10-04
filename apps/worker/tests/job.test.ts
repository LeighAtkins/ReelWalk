import { describe, expect, it } from "vitest";
import { inputFilenameFor, outputKeyFor, parseRenderJobPayload } from "../src/job";

describe("render job payloads", () => {
  it("parses valid queue payloads", () => {
    expect(parseRenderJobPayload('{"jobId":"job-1","listingId":"listing-1","inputKey":"uploads/a.mp4"}')).toEqual({
      jobId: "job-1",
      listingId: "listing-1",
      inputKey: "uploads/a.mp4",
    });
  });

  it("builds deterministic render output keys", () => {
    expect(outputKeyFor({ jobId: "job-1", listingId: "listing-1", inputKey: "uploads/a.mp4" })).toBe(
      "renders/listing-1/job-1.mp4",
    );
  });

  it("preserves the input extension so images are not treated as video", () => {
    expect(inputFilenameFor({ inputKey: "uploads/l/x.mp4" })).toBe("input.mp4");
    expect(inputFilenameFor({ inputKey: "uploads/l/x.JPG" })).toBe("input.jpg");
    expect(inputFilenameFor({ inputKey: "uploads/l/x.jpeg" })).toBe("input.jpeg");
    expect(inputFilenameFor({ inputKey: "uploads/l/x.png" })).toBe("input.png");
    expect(inputFilenameFor({ inputKey: "uploads/l/x.mov" })).toBe("input.mov");
  });

  it("falls back to .mp4 for unknown or missing extensions", () => {
    expect(inputFilenameFor({ inputKey: "uploads/l/noext" })).toBe("input.mp4");
    expect(inputFilenameFor({ inputKey: "uploads/l/x.exe" })).toBe("input.mp4");
  });
});
