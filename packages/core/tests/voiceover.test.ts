import { describe, expect, it } from "vitest";
import { applyCommand, COMMAND_TYPES, type CommandContext } from "../src/commands";
import { duckGain, speechWindows } from "../src/ducking";
import { parseTimeline, referencedAssetIds, type Timeline, type Voiceover } from "../src/timeline";
import type { Transcript } from "../src/transcript";
import { DEFAULT_VOICE, VOICES, isVoiceId, scriptTimedWords, voiceoverCaptions, voiceoverWords } from "../src/voiceover";

// A spoken voiceover over the footage (ADR 0099).

const ctx: CommandContext = { generation: 0, sourceDurationsMs: { v1: 20000 } };

function reel(): Timeline {
  return parseTimeline({
    version: 1,
    clips: [
      { id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 6000, volume: 0 },
      { id: "b", assetId: "p", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 6000 },
    ],
    texts: [{ id: "hook", text: "Just listed", startMs: 0, endMs: 2000, style: "elegant" }],
    music: { assetId: "song", volume: 0.8 },
  });
}

const vo: Voiceover = { assetId: "vo1", atMs: 500, volume: 1, script: "Three bedrooms. A garden that catches the sun.", voice: "aura-2:theia" };
const spoken: Transcript = {
  text: "Three bedrooms. A garden that catches the sun.",
  words: [
    { w: "Three", s: 0, e: 300 },
    { w: "bedrooms.", s: 320, e: 900 },
    { w: "A", s: 1300, e: 1400 },
    { w: "garden", s: 1420, e: 1800 },
    { w: "that", s: 1820, e: 1950 },
    { w: "catches", s: 1970, e: 2300 },
    { w: "the", s: 2320, e: 2400 },
    { w: "sun.", s: 2420, e: 2900 },
  ],
};

describe("the voices", () => {
  it("are Aura-2 voices, Australian first, and the default is one of them", () => {
    expect(VOICES.slice(0, 2).map((voice) => voice.id)).toEqual(["aura-2:theia", "aura-2:hyperion"]);
    expect(isVoiceId(DEFAULT_VOICE)).toBe(true);
    expect(isVoiceId("aura-2:nobody")).toBe(false);
    expect(new Set(VOICES.map((voice) => voice.id)).size).toBe(VOICES.length);
  });
});

describe("the voiceover on a reel", () => {
  it("survives a parse, is absent on reels without one, and is a referenced asset", () => {
    expect(reel().voiceover).toBeUndefined();
    const withIt = parseTimeline({ ...reel(), voiceover: vo });
    expect(withIt.voiceover).toEqual(vo);
    expect(referencedAssetIds(withIt)).toContain("vo1");
  });

  it("puts its words in reel time, from where it starts", () => {
    expect(voiceoverWords(vo, spoken).slice(0, 2)).toEqual([{ w: "Three", s: 500, e: 800 }, { w: "bedrooms.", s: 820, e: 1400 }]);
    expect(voiceoverWords(vo, null)).toEqual([]);
  });

  it("dips the music under its words and not elsewhere", () => {
    const timeline = parseTimeline({ ...reel(), voiceover: vo });
    const windows = speechWindows(timeline, { vo1: spoken });
    expect(windows.length).toBeGreaterThan(0);
    expect(duckGain(windows, 2500)).toBeLessThan(1);
    expect(duckGain(windows, 10_000)).toBe(1);
    // Muted voiceover: no dips.
    expect(speechWindows(parseTimeline({ ...reel(), voiceover: { ...vo, volume: 0 } }), { vo1: spoken })).toEqual([]);
  });
});

describe("setVoiceover", () => {
  it("is a command every agent can reach", () => {
    expect(COMMAND_TYPES).toContain("setVoiceover");
  });

  it("sets the voiceover and captions its phrases, each word coming into focus as it is said", () => {
    const { timeline } = applyCommand(reel(), { type: "setVoiceover", voiceover: vo, transcript: spoken }, ctx);
    expect(timeline.voiceover).toEqual(vo);
    const captions = timeline.texts.filter((text) => text.id.startsWith("vo-"));
    expect(captions.map((text) => text.text).join(" ")).toBe(spoken.text);
    expect(captions[0].startMs).toBe(500);
    for (const caption of captions) {
      expect(caption.kinetic?.preset).toBe("focus");
      expect(caption.kinetic?.wordsMs?.length).toBe(caption.text.split(" ").length);
      expect(caption.y).toBeLessThanOrEqual(0.72);
    }
    // The hook title is left alone.
    expect(timeline.texts.some((text) => text.id === "hook")).toBe(true);
  });

  it("replaces its captions when set again, leaves them off when asked, and takes everything off with null", () => {
    const once = applyCommand(reel(), { type: "setVoiceover", voiceover: vo, transcript: spoken }, ctx).timeline;
    const twice = applyCommand(once, { type: "setVoiceover", voiceover: vo, transcript: spoken }, ctx).timeline;
    expect(twice.texts.filter((text) => text.id.startsWith("vo-")).length).toBe(once.texts.filter((text) => text.id.startsWith("vo-")).length);
    // A voiceover without captions is still a change (so it is saved).
    expect(applyCommand(reel(), { type: "setVoiceover", voiceover: vo, captions: false }, ctx).changes).toEqual([{ kind: "other", key: "voiceover" }]);
    const bare = applyCommand(once, { type: "setVoiceover", voiceover: vo, transcript: spoken, captions: false }, ctx).timeline;
    expect(bare.texts.some((text) => text.id.startsWith("vo-"))).toBe(false);
    expect(bare.voiceover).toEqual(vo);
    const off = applyCommand(once, { type: "setVoiceover", voiceover: null }, ctx).timeline;
    expect(off.voiceover).toBeUndefined();
    expect(off.texts.map((text) => text.id)).toEqual(["hook"]);
  });

  it("refuses a voiceover that does not fit the schema", () => {
    const bad = applyCommand(reel(), { type: "setVoiceover", voiceover: { ...vo, script: "x".repeat(401) } }, ctx);
    expect(bad.rejected).toMatch(/not valid/);
    expect(bad.timeline.voiceover).toBeUndefined();
  });

  it("captions only what fits the reel", () => {
    const late = { ...vo, atMs: 11_000 };
    expect(voiceoverCaptions(late, spoken).length).toBeGreaterThan(0);
    const { timeline } = applyCommand(reel(), { type: "setVoiceover", voiceover: late, transcript: spoken }, ctx);
    for (const caption of timeline.texts) expect(caption.endMs).toBeLessThanOrEqual(12_000);
  });
});

describe("captions show the script, timed by what was heard", () => {
  // What Whisper heard from the Hyperion voice for this script, 2026-10-31 (the voice Worker preview, ADR 0099).
  const script = "Three bedrooms, a north-facing garden, and room to grow. Open home Saturday at ten.";
  const heard: Transcript = {
    text: "Three bedrooms and all-facing garden and room to grow. Open Home Saturday at 10.",
    words: [
      { w: "Three", s: 370, e: 730 }, { w: "bedrooms", s: 730, e: 1350 }, { w: "and", s: 1450, e: 1590 }, { w: "all-facing", s: 1600, e: 2200 },
      { w: "garden", s: 2210, e: 2770 }, { w: "and", s: 2860, e: 3000 }, { w: "room", s: 3010, e: 3300 }, { w: "to", s: 3310, e: 3420 },
      { w: "grow.", s: 3430, e: 3830 }, { w: "Open", s: 4210, e: 4500 }, { w: "Home", s: 4510, e: 4800 }, { w: "Saturday", s: 4810, e: 5300 },
      { w: "at", s: 5310, e: 5400 }, { w: "10.", s: 5410, e: 5770 },
    ],
  };

  it("keeps every script word, in order, with times that never run backwards", () => {
    const words = scriptTimedWords(script, heard)!;
    expect(words.map((word) => word.w).join(" ")).toBe(script);
    for (let index = 1; index < words.length; index++) expect(words[index].s).toBeGreaterThanOrEqual(words[index - 1].s);
    // Matched words keep their heard times; a misheard one takes the time of what was heard in its place.
    expect(words[0]).toEqual({ w: "Three", s: 370, e: 730 });
    expect(words.find((word) => word.w === "ten.")).toEqual({ w: "ten.", s: 5410, e: 5770 });
    expect(words.find((word) => word.w === "garden,")).toEqual({ w: "garden,", s: 2210, e: 2770 });
  });

  it("captions the script's words, not the mishearing", () => {
    const captions = voiceoverCaptions({ assetId: "vo1", atMs: 0, volume: 1, script, voice: "aura-2:hyperion" }, heard);
    const text = captions.map((caption) => caption.text).join(" ");
    expect(text).toBe(script);
    expect(text).not.toContain("all-facing");
    expect(captions[0].startMs).toBe(370);
  });

  it("spaces words the recogniser dropped between their neighbours", () => {
    const dropped: Transcript = { text: "Three garden", words: [{ w: "Three", s: 0, e: 300 }, { w: "garden", s: 900, e: 1200 }] };
    expect(scriptTimedWords("Three lovely green garden", dropped)).toEqual([
      { w: "Three", s: 0, e: 300 }, { w: "lovely", s: 300, e: 600 }, { w: "green", s: 600, e: 900 }, { w: "garden", s: 900, e: 1200 },
    ]);
    expect(scriptTimedWords("Hi", null)).toBeNull();
  });
});
