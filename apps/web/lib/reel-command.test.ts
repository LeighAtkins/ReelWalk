import { describe, expect, it, vi } from "vitest";
import { applyCommand, parseTimeline, type Command } from "@reelwalk/core";

vi.mock("@reelwalk/db", () => ({ prisma: {} }));
vi.mock("./brand-kit", () => ({ workspaceBrandKit: async () => null }));
vi.mock("./library", () => ({ toLibraryAssets: async () => [] }));
vi.mock("./reels", () => ({ readTimeline: (value: unknown) => value }));
vi.mock("./save-reel", () => ({ saveReelFor: async () => ({ ok: true, revision: 1 }) }));
vi.mock("./workspace", () => ({ mediaScope: () => ({}) }));

import { withLibraryInputs } from "./reel-command";

const library = {
  take: { id: "take", kind: "VIDEO", durationMs: 8000, transcript: { text: "your words on the walls", words: [{ w: "Your", s: 200, e: 700 }, { w: "words", s: 800, e: 1600 }, { w: "on", s: 1700, e: 1800 }, { w: "the", s: 1850, e: 2300 }, { w: "walls.", s: 2400, e: 2700 }] } },
  plate: { id: "plate", kind: "IMAGE", durationMs: null, transcript: null },
} as never;
const timeline = parseTimeline({
  version: 1,
  clips: [{ id: "a", assetId: "take", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 8000 }],
  texts: [{ id: "l3", text: "Your words, on the walls.", startMs: 0, endMs: 8000, style: "elegant" }],
  music: null,
});

describe("withLibraryInputs: syncTextToSpeech (ADR 0084)", () => {
  it("fills the transcripts in, alone and inside a batch, so an agent sends only the title", () => {
    const one = withLibraryInputs({ type: "syncTextToSpeech", textId: "l3" }, library) as Extract<Command, { type: "syncTextToSpeech" }>;
    expect(Object.keys(one.speech ?? {})).toEqual(["take"]);
    const batch = withLibraryInputs({ type: "batch", commands: [{ type: "updateText", textId: "l3", patch: { behind: true } }, { type: "syncTextToSpeech", textId: "l3" }] }, library);
    if (batch.type !== "batch") throw new Error("expected a batch");
    expect(batch.commands[0]).toEqual({ type: "updateText", textId: "l3", patch: { behind: true } });
    expect((batch.commands[1] as Extract<Command, { type: "syncTextToSpeech" }>).speech?.take).toHaveLength(5);
    // And the filled command applies: the title starts on "Your" (less the lead) and each word lands on its time.
    const result = applyCommand(timeline, batch, { generation: 0 });
    expect(result.rejected).toBeUndefined();
    expect(result.timeline.texts[0]).toMatchObject({ startMs: 140, endMs: 3400, behind: true, kinetic: { preset: "words", wordsMs: [0, 600, 1500, 1650, 2200] } });
  });

  it("keeps transcripts an agent sent itself", () => {
    const speech = { take: [{ w: "hi", s: 0, e: 100 }] };
    expect(withLibraryInputs({ type: "syncTextToSpeech", textId: "l3", speech }, library)).toMatchObject({ speech });
  });
});
