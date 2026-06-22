import { describe, expect, it } from "vitest";
import { outputKeyFor, parseRenderJobPayload } from "../src/job";

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
});
