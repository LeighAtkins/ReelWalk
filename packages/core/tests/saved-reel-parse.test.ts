import { describe, expect, it } from "vitest";
import { parseTimeline, timelineSchema } from "../src";

/**
 * Saved reels must parse the same after a zod bump (the CVE-2023-54404 fix moved zod to 4.6.7). The snapshot file was
 * written under zod 4.6.5 and has to match unchanged under the new version: same defaults, same stripped keys, same
 * error paths and codes for what is refused.
 */
const legacyReel = {
  version: 1,
  clips: [
    { id: "c1", assetId: "a1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
    { id: "c2", assetId: "a2", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000, motion: "zoom-in", room: "living room" },
  ],
  texts: [{ id: "t1", text: "Just listed", startMs: 0, endMs: 3000, style: "headline" }],
  music: null,
};

const midLifeReel = {
  version: 1,
  clips: [
    { id: "c1", assetId: "a1", kind: "VIDEO", sourceStartMs: 500, sourceEndMs: 6500, speed: 1.5, volume: 0.4, fit: "contain", filter: "none", transitionIn: "cut", room: "kitchen", unknownLegacyKey: true },
    { id: "c2", assetId: "a3", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 2500, zoom: 1.4, spot: { x: 0.5, y: 0.25, heading: 90 } },
  ],
  texts: [{ id: "t1", text: "Corner flat", startMs: 200, endMs: 2200, style: "headline" }],
  music: { assetId: "s1", sourceStartMs: 0, volume: 0.8, bpm: 96, beatOffsetMs: 120 },
  plan: null,
  details: { price: " £450,000 ", beds: "2", baths: "1" },
  logo: null,
  cover: null,
  hook: null,
};

const refused = {
  zeroLengthClip: { ...legacyReel, clips: [{ id: "c1", assetId: "a1", kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 1000 }] },
  wrongVersion: { ...legacyReel, version: 2 },
  missingClips: { version: 1, texts: [], music: null },
  speedOutOfRange: { ...legacyReel, clips: [{ id: "c1", assetId: "a1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 1000, speed: 9 }] },
};

describe("saved reels parse unchanged across zod versions", () => {
  it("fills the defaults of a reel saved before the later fields existed", () => {
    expect(parseTimeline(legacyReel)).toMatchSnapshot();
  });

  it("keeps a mid-life reel's fields and drops keys the schema never had", () => {
    const parsed = parseTimeline(midLifeReel);
    expect(parsed.clips[0]).not.toHaveProperty("unknownLegacyKey");
    expect(parsed).toMatchSnapshot();
  });

  it("parsing its own output changes nothing", () => {
    const once = parseTimeline(midLifeReel);
    expect(parseTimeline(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it("refuses the same reels, at the same paths, with the same codes", () => {
    const summary = Object.fromEntries(
      Object.entries(refused).map(([name, value]) => {
        const result = timelineSchema.safeParse(value);
        return [name, result.success ? "parsed" : result.error.issues.map((i) => ({ code: i.code, path: i.path.join("."), message: i.message }))];
      }),
    );
    expect(summary).toMatchSnapshot();
  });
});
