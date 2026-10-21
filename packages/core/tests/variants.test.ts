import { describe, expect, it } from "vitest";
import { DEFAULT_PANO, clipDurationMs, clipStartsMs, parseTimeline, referencedAssetIds, timelineDurationMs, timelineSchema, type Timeline } from "../src/timeline";
import { MAX_OVER_MS, MIN_VARIANT_SHOT_MS, buildVariant, buildVariants, heroClipId, presenterClipId, titleCardText, variantWinner, type VariantInput } from "../src/variants";

const ROOMS = ["front door", "living room", "kitchen", "dining room", "primary bedroom", "bathroom", "bedroom", "office", "patio", "exterior", "garden", "pool"];

/** A finished 12-shot reel: photos and videos, one video with the presenter speaking, titles, a song with a tempo. */
function reel(extra: Partial<Record<keyof Timeline, unknown>> = {}): Timeline {
  return parseTimeline({
    version: 1,
    clips: ROOMS.map((room, i) =>
      i % 3 === 1
        ? { id: `c${i + 1}`, assetId: i === 4 ? "talk" : `video${i + 1}`, kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 5000, room }
        : { id: `c${i + 1}`, assetId: `photo${i + 1}`, kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000, room, motion: "zoom-in" },
    ),
    texts: [
      { id: "t-open", text: "Just listed", startMs: 200, endMs: 2500, style: "headline" },
      { id: "t-kitchen", text: "Chef's kitchen", startMs: 7200, endMs: 9000 },
    ],
    music: { assetId: "song", bpm: 120, beatOffsetMs: 0 },
    ...extra,
  });
}

const words = (text: string, startMs: number, stepMs: number) =>
  text.split(" ").map((w, i) => ({ w, s: startMs + i * stepMs, e: startMs + i * stepMs + stepMs - 80 }));

const input: VariantInput = {
  title: "Hillside villa",
  sourceDurationsMs: Object.fromEntries(ROOMS.map((_, i) => [`video${i + 1}`, 12000]).concat([["talk", 20000]])),
  transcripts: { talk: { text: "", words: words("Welcome to the most beautiful home on the hill, come and see it with me today", 0, 600) } },
};

describe("variant choices", () => {
  it("the hero is the cover when one is set, else the exterior, else the first shot", () => {
    expect(heroClipId(reel())).toBe("c10");
    expect(heroClipId(reel({ cover: { clipId: "c3", offsetMs: 0 } }))).toBe("c3");
    expect(heroClipId(parseTimeline({ ...reel(), clips: reel().clips.map((clip) => ({ ...clip, room: null })) }))).toBe("c1");
  });

  it("the presenter is the first video with speech inside the part that plays", () => {
    expect(presenterClipId(reel(), input.transcripts)).toBe("c5");
    // Speech only after the clip's window: not a presenter line.
    expect(presenterClipId(reel(), { talk: { text: "", words: [{ w: "late", s: 9000, e: 9400 }] } })).toBeNull();
    expect(presenterClipId(reel(), {})).toBeNull();
  });

  it("the title card says the price and address, else the first headline, else the title unless it is a default name", () => {
    expect(titleCardText(reel(), "Reel 4")).toBe("Just listed");
    expect(titleCardText(reel({ texts: [] }), "Reel 4")).toBeNull();
    expect(titleCardText(reel({ texts: [] }), "Hillside villa")).toBe("Hillside villa");
    expect(titleCardText(reel({ details: { price: "$1,200,000", address: "4 Hill Rd" } }), "x")).toBe("$1,200,000 · 4 Hill Rd");
  });
});

describe("building variants", () => {
  it("makes three hooks at two lengths from a full reel", () => {
    const { variants, skipped } = buildVariants(reel(), input);
    expect(skipped).toEqual([]);
    expect(variants.map((v) => `${v.hook}-${v.lengthS}`)).toEqual(["hero-15", "hero-30", "presenter-15", "presenter-30", "title-15", "title-30"]);
    for (const variant of variants) expect(timelineSchema.safeParse(variant.timeline).success).toBe(true);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(buildVariants(reel(), input))).toBe(JSON.stringify(buildVariants(reel(), input)));
  });

  it("shares the source's assets and copies no media: every asset a variant uses is one the reel already used", () => {
    const source = reel();
    const used = new Set(referencedAssetIds(source));
    for (const variant of buildVariants(source, input).variants) {
      for (const id of referencedAssetIds(variant.timeline)) expect(used.has(id)).toBe(true);
      // Clips are the source's own (same ids), not copies.
      for (const clip of variant.timeline.clips) expect(source.clips.some((c) => c.id === clip.id && c.assetId === clip.assetId)).toBe(true);
    }
  });

  it("leaves the source reel untouched", () => {
    const source = reel();
    const before = JSON.stringify(source);
    buildVariants(source, input);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("opens each variant on its hook", () => {
    const { variants } = buildVariants(reel(), input);
    const first = (hook: string, lengthS: number) => variants.find((v) => v.hook === hook && v.lengthS === lengthS)!.timeline;
    expect(first("hero", 15).clips[0].id).toBe("c10");
    expect(first("hero", 15).cover).toEqual({ clipId: "c10", offsetMs: 0 });
    expect(first("presenter", 15).clips[0].id).toBe("c5");
    const title = first("title", 15);
    expect(title.clips[0].id).toBe("c1");
    expect(title.texts[0]).toMatchObject({ id: "variant-title", text: "Just listed", startMs: 0 });
    // The title card replaces the old opener rather than sitting on it.
    expect(title.texts.filter((t) => t.startMs < 2500 && !t.id.startsWith("room-"))).toHaveLength(1);
  });

  it("keeps the ending shot and drops shots evenly, with their own titles", () => {
    const hero15 = buildVariant(reel(), "hero", 15, input);
    if ("reason" in hero15) throw new Error(hero15.reason);
    expect(hero15.timeline.clips.at(-1)!.id).toBe("c12");
    expect(hero15.timeline.clips.length).toBe(15000 / MIN_VARIANT_SHOT_MS);
    // The kitchen (c3) is dropped from the 15 s hero cut, and so is its title.
    expect(hero15.timeline.clips.some((c) => c.id === "c3")).toBe(false);
    expect(hero15.timeline.texts.some((t) => t.id === "t-kitchen")).toBe(false);
  });
});

describe("retime to 15 and 30 s", () => {
  const { variants } = buildVariants(reel(), input);

  it("brings each variant to about its length, never far over, every shot long enough to see", () => {
    for (const variant of variants) {
      const target = variant.lengthS * 1000;
      expect(variant.totalMs).toBe(timelineDurationMs(variant.timeline));
      // Within a beat (500 ms at 120 bpm) a shot, either way.
      expect(variant.totalMs, `${variant.hook}-${variant.lengthS}`).toBeGreaterThan(target * 0.85);
      expect(variant.totalMs, `${variant.hook}-${variant.lengthS}`).toBeLessThanOrEqual(target + MAX_OVER_MS);
      for (const clip of variant.timeline.clips) expect(clipDurationMs(clip)).toBeGreaterThanOrEqual(1000);
    }
  });

  it("gives the presenter's line its words: cut after a whole word, not mid-word", () => {
    const presenter = variants.find((v) => v.hook === "presenter" && v.lengthS === 15)!;
    const lead = presenter.timeline.clips[0];
    expect(lead.assetId).toBe("talk");
    // At most 45% of the variant; the source window played 4 s, all of which fits.
    expect(clipDurationMs(lead)).toBeLessThanOrEqual(15000 * 0.45 + 600);
    const spoken = input.transcripts!.talk!.words;
    // The studio's trim ended inside "hill," (4.8–5.32 s): the word is finished.
    expect(lead.sourceEndMs).toBe(5400);
    expect(spoken.some((w) => w.s < lead.sourceEndMs && w.e > lead.sourceEndMs)).toBe(false);
  });

  it("a long presenter take is cut after the last whole word that fits", () => {
    const long = reel({ clips: reel().clips.map((clip) => (clip.id === "c5" ? { ...clip, sourceStartMs: 0, sourceEndMs: 16000 } : clip)) });
    const made = buildVariant(long, "presenter", 15, input);
    if ("reason" in made) throw new Error(made.reason);
    const lead = made.timeline.clips[0];
    expect(lead.sourceStartMs).toBe(0);
    // 45% of 15 s is 6.75 s, inside "see" (6.6–7.12 s): the cut comes back to the end of "and", up to the next word.
    expect(lead.sourceEndMs).toBe(6600);
    expect(input.transcripts!.talk!.words.some((w) => w.s < lead.sourceEndMs && w.e > lead.sourceEndMs)).toBe(false);
  });

  it("measures the real length: 360 photos cannot be shortened, so fewer of them are kept", () => {
    // Eight 360 photos: retime holds each at least 3.5 s, so keeping all eight would make a 28 s "15 s" variant.
    const panos = parseTimeline({
      version: 1,
      clips: Array.from({ length: 8 }, (_, i) => ({ id: `p${i + 1}`, assetId: `pano${i + 1}`, kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 5000, pano: DEFAULT_PANO, room: i === 0 ? "exterior" : "living room" })),
      texts: [],
      music: null,
    });
    const { variants: made } = buildVariants(panos, { title: "Lodge", sourceDurationsMs: {} });
    const hero15 = made.find((v) => v.hook === "hero" && v.lengthS === 15)!;
    expect(hero15.totalMs).toBeLessThanOrEqual(15000 + MAX_OVER_MS);
    expect(hero15.timeline.clips.length).toBe(4);
    expect(hero15.timeline.clips.at(-1)!.id).toBe("p8");
    const hero30 = made.find((v) => v.hook === "hero" && v.lengthS === 30)!;
    expect(hero30.totalMs).toBeLessThanOrEqual(30000 + MAX_OVER_MS);
    for (const variant of made) expect(variant.totalMs).toBeLessThanOrEqual(variant.lengthS * 1000 + MAX_OVER_MS);
  });

  it("skips the presenter variant when her line cannot be cut between words", () => {
    const long = reel({ clips: reel().clips.map((clip) => (clip.id === "c5" ? { ...clip, sourceStartMs: 0, sourceEndMs: 16000 } : clip)) });
    // One word runs from 0.9 s to 9 s: no pause within the 6.75 s the line may take, and none a second in.
    const made = buildVariant(long, "presenter", 15, { ...input, transcripts: { talk: { text: "", words: [{ w: "so", s: 0, e: 900 }, { w: "welcome", s: 900, e: 9000 }] } } });
    expect("reason" in made && made.reason).toMatch(/mid-word/);
  });

  it("a short reel has no 30 s version, and says why", () => {
    const short = parseTimeline({ ...reel(), clips: reel().clips.slice(0, 3) });
    const { variants: made, skipped } = buildVariants(short, input);
    expect(made.every((v) => v.lengthS === 15)).toBe(true);
    expect(skipped.find((s) => s.hook === "hero" && s.lengthS === 30)?.reason).toMatch(/Not enough footage/);
  });

  it("without a presenter or a title the variants that need them are skipped with a reason", () => {
    const plain = reel({ texts: [] });
    const { variants: made, skipped } = buildVariants(plain, { ...input, title: "Reel 9", transcripts: {} });
    expect(made.map((v) => v.hook)).toEqual(["hero", "hero"]);
    expect(skipped.map((s) => s.hook)).toEqual(["presenter", "presenter", "title", "title"]);
    expect(skipped[0].reason).toMatch(/speaking/);
  });
});

describe("pinned titles in variants", () => {
  // c2 and c8 are 10 s videos shown in full in the source, each with a title tracked on part of it.
  function pinned(): Timeline {
    const base = reel({ clips: reel().clips.map((clip) => (clip.id === "c2" || clip.id === "c8" ? { ...clip, sourceStartMs: 0, sourceEndMs: 10000 } : clip)) });
    const starts = clipStartsMs(base);
    const at = (id: string) => starts[base.clips.findIndex((clip) => clip.id === id)];
    return parseTimeline({
      ...base,
      texts: [
        ...base.texts,
        // Tracked on 0.5–2.5 s: the 2.5 s middle a variant keeps (3.75–6.25 s) never shows it.
        { id: "pin-early", text: "Oak floors", startMs: at("c2") + 500, endMs: at("c2") + 2500, pin: { assetId: "video2", fromMs: 500, toMs: 2500 } },
        // Tracked on 4–6 s: still on screen in the middle.
        { id: "pin-middle", text: "Fireplace", startMs: at("c8") + 4000, endMs: at("c8") + 6000, pin: { assetId: "video8", fromMs: 4000, toMs: 6000 } },
      ],
    });
  }
  const durations = { ...input, sourceDurationsMs: { ...input.sourceDurationsMs, video2: 10000, video8: 10000 } };

  it("drops a pinned title whose tracked frames are no longer shown, and keeps one whose frames are", () => {
    const made = buildVariant(pinned(), "title", 30, durations);
    if ("reason" in made) throw new Error(made.reason);
    expect(made.timeline.clips.find((clip) => clip.id === "c2")).toMatchObject({ sourceStartMs: 3750, sourceEndMs: 6250 });
    expect(made.timeline.texts.some((text) => text.id === "pin-early")).toBe(false);
    expect(made.timeline.texts.find((text) => text.id === "pin-middle")).toBeTruthy();
  });

  it("every pinned title left in any variant sits over the asset and frames it was tracked on, for at least 400 ms", () => {
    for (const variant of buildVariants(pinned(), durations).variants) {
      const starts = clipStartsMs(variant.timeline);
      for (const text of variant.timeline.texts.filter((t) => t.pin)) {
        const index = starts.findIndex((start, i) => text.startMs >= start && text.startMs < start + clipDurationMs(variant.timeline.clips[i]));
        const clip = variant.timeline.clips[index];
        expect(clip.assetId).toBe(text.pin!.assetId);
        expect(Math.min(clip.sourceEndMs, text.pin!.toMs) - Math.max(clip.sourceStartMs, text.pin!.fromMs)).toBeGreaterThanOrEqual(600);
        expect(text.endMs - text.startMs).toBeGreaterThanOrEqual(400);
      }
    }
  });
});

describe("listing details in variants", () => {
  const details = { price: "$950,000", address: "12 Shore St", beds: "3", placement: "end" };

  it("the title variant opens on the facts card; the others keep the opening clear", () => {
    const withCard = reel({ details: { ...details, placement: "both" } });
    const { variants } = buildVariants(withCard, input);
    const title = variants.find((v) => v.hook === "title")!.timeline;
    expect(title.details?.placement).toBe("both");
    expect(title.texts.some((t) => t.id === "variant-title")).toBe(false);
    expect(variants.find((v) => v.hook === "hero")!.timeline.details?.placement).toBe("end");
  });

  it("the title variant of a reel with the card at the end puts it at both ends", () => {
    const { variants } = buildVariants(reel({ details }), input);
    expect(variants.find((v) => v.hook === "title")!.timeline.details?.placement).toBe("both");
  });
});

describe("winner", () => {
  it("names the variant with most plays, then reach, only with two or more posted", () => {
    expect(variantWinner([{ reelId: "a", views: 900, reach: 700 }, { reelId: "b", views: 1200, reach: 650 }, { reelId: "c", views: null, reach: null }])).toBe("b");
    expect(variantWinner([{ reelId: "a", views: 900, reach: 700 }, { reelId: "b", views: 900, reach: 800 }])).toBe("b");
    expect(variantWinner([{ reelId: "a", views: 900, reach: 700 }, { reelId: "b", views: null, reach: null }])).toBeNull();
    expect(variantWinner([{ reelId: "a", views: 5, reach: 5 }, { reelId: "b", views: 5, reach: 5 }])).toBeNull();
  });
});
