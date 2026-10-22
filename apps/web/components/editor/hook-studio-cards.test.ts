import { describe, expect, it } from "vitest";
import { HOOK_INTERRUPT_CLIP_ID, HOOK_TEXT_PREFIX, parseTimeline, type Timeline } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { createDocumentStore } from "./document-store";
import { emptyMeasure } from "./hook-motion";
import { hookCommand, initialPattern, studioCards } from "./hook-studio-cards";

// The Hook studio (ADR 0068): one card per pattern from the editor's library, the same plan the tap applies,
// and applying through the document store as one history entry that one undo removes.

const asset = (id: string, kind: LibraryAsset["kind"], extra: Partial<LibraryAsset> = {}): LibraryAsset => ({
  id, kind, fileName: `${id}.mp4`, url: `blob:${id}`, thumbUrl: null, durationMs: kind === "VIDEO" ? 20000 : null, width: 1080, height: 1920, isPano: false,
  credit: null, tourId: null, spot: null, room: null, bpm: null, beatOffsetMs: null, songMap: null, previewPending: false, instagram: null, transcript: null, ...extra,
});

const library: Record<string, LibraryAsset> = {
  "v-a": asset("v-a", "VIDEO"),
  "v-b": asset("v-b", "VIDEO"),
  "p-s": asset("p-s", "IMAGE"),
  "v-talk": asset("v-talk", "VIDEO", { transcript: { text: "come and see the pool", words: "come and see the pool".split(" ").map((w, i) => ({ w, s: 1500 + i * 280, e: 1500 + i * 280 + 240 })) } }),
};

const reel = (): Timeline => parseTimeline({
  version: 1,
  clips: [
    { id: "a", assetId: "v-a", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000, volume: 0 },
    { id: "s", assetId: "p-s", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 2500 },
    { id: "talk", assetId: "v-talk", kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 7000, volume: 1 },
    { id: "b", assetId: "v-b", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000, volume: 0 },
  ],
  texts: [{ id: "pool", text: "The pool", startMs: 6000, endMs: 8000, style: "elegant" }],
  music: null,
});

const inputs = { line: "", promise: "", headline: "Villa Sol", measure: emptyMeasure() };

describe("the Hook studio's cards", () => {
  it("offers every pattern the reel can make, with its plan and the rules it passes", () => {
    const cards = studioCards(reel(), library, inputs);
    expect(cards.map((card) => [card.pattern, card.plan !== null])).toEqual([["voice-in", true], ["motion-in", true], ["text-punch", true], ["pattern-interrupt", true], ["question", true]]);
    const voice = cards[0];
    expect(voice.plan!.timeline.clips[0]).toMatchObject({ id: "talk", sourceStartMs: 1420 });
    expect(voice.rules.find((rule) => rule.rule === "title-300")).toMatchObject({ ok: true });
    expect(voice.rules.find((rule) => rule.rule === "motion-500")).toMatchObject({ ok: true });
    expect(voice.passes).toBe(voice.judged);
    expect(initialPattern(reel(), cards)).toBe("voice-in");
  });

  it("says why a pattern cannot be made", () => {
    const silent = parseTimeline({ ...reel(), clips: reel().clips.filter((clip) => clip.id !== "talk") });
    const cards = studioCards(silent, library, { ...inputs, headline: null });
    expect(cards.find((card) => card.pattern === "voice-in")).toMatchObject({ plan: null, unavailable: expect.stringContaining("speaks") });
    expect(cards.find((card) => card.pattern === "text-punch")).toMatchObject({ plan: null, unavailable: expect.stringContaining("hook line") });
    expect(initialPattern(silent, cards)).toBe("motion-in");
  });

  it("applies through the document store as one entry that one undo removes, and the card's plan is what lands", () => {
    const store = createDocumentStore(reel(), () => ({ "v-a": 20000, "v-b": 20000, "v-talk": 20000 }));
    const before = store.getState().history.present;
    const studio = { ...inputs, line: "Would you swim here?", promise: "The pool at the end" };
    const card = studioCards(reel(), library, studio).find((item) => item.pattern === "pattern-interrupt")!;
    const outcome = store.runCommand(hookCommand("pattern-interrupt", library, studio));
    expect(outcome.rejected).toBeUndefined();
    const after = store.getState().history.present;
    expect(after).toEqual(card.plan!.timeline);
    expect(after.clips[0].id).toBe(HOOK_INTERRUPT_CLIP_ID);
    expect(after.texts.filter((text) => text.id.startsWith(HOOK_TEXT_PREFIX)).map((text) => text.text)).toEqual(["Would you swim here?", "The pool at the end"]);
    expect(after.opening).toMatchObject({ pattern: "pattern-interrupt", titles: ["Would you swim here?"] });
    expect(store.getState().history.past).toHaveLength(1);
    store.dispatch({ type: "undo" });
    expect(store.getState().history.present).toEqual(before);
    // Clearing is one entry too.
    store.runCommand(hookCommand("question", library, studio));
    store.runCommand({ type: "hook", pattern: null });
    expect(store.getState().history.present.texts.some((text) => text.id.startsWith(HOOK_TEXT_PREFIX))).toBe(false);
    expect(store.getState().history.present.opening).toBeUndefined();
  });
});
