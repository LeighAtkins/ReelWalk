import { describe, expect, it } from "vitest";
import { sampleReels } from "./sample-reels";

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe("sampleReels", () => {
  it("is empty with nothing set", () => {
    expect(sampleReels(env({}))).toEqual([]);
  });

  it("pairs each reel with its poster, label and raw clips by position (ADR 0085)", () => {
    const samples = sampleReels(
      env({
        SAMPLE_REEL_URL: "https://cdn/a.mp4, https://cdn/b.mp4,https://cdn/c.mp4",
        SAMPLE_REEL_POSTER_URL: "https://cdn/a.jpg,,https://cdn/c.jpg",
        SAMPLE_REEL_LABELS: "From 9 phone clips,Your words on the walls,Cut to the beat",
        SAMPLE_REEL_RAW_URLS: "https://cdn/a-raw.jpg,,",
      }),
    );
    expect(samples).toEqual([
      { src: "https://cdn/a.mp4", poster: "https://cdn/a.jpg", label: "From 9 phone clips", raw: "https://cdn/a-raw.jpg" },
      { src: "https://cdn/b.mp4", poster: null, label: "Your words on the walls", raw: null },
      { src: "https://cdn/c.mp4", poster: "https://cdn/c.jpg", label: "Cut to the beat", raw: null },
    ]);
  });

  it("keeps positions when a reel URL is not a URL, and stops at three", () => {
    const samples = sampleReels(
      env({
        SAMPLE_REEL_URL: "nope,https://cdn/b.mp4,https://cdn/c.mp4,https://cdn/d.mp4,https://cdn/e.mp4",
        SAMPLE_REEL_LABELS: "A,B,C,D,E",
        SAMPLE_REEL_RAW_URLS: "javascript:alert(1),https://cdn/b-raw.jpg",
      }),
    );
    expect(samples.map((sample) => [sample.src, sample.label, sample.raw])).toEqual([
      ["https://cdn/b.mp4", "B", "https://cdn/b-raw.jpg"],
      ["https://cdn/c.mp4", "C", null],
      ["https://cdn/d.mp4", "D", null],
    ]);
  });

  it("keeps labels short and plain", () => {
    const [sample] = sampleReels(env({ SAMPLE_REEL_URL: "https://cdn/a.mp4", SAMPLE_REEL_LABELS: `<b>${"x".repeat(60)}</b>` }));
    expect(sample!.label).toBe(`b${"x".repeat(39)}`);
  });
});
