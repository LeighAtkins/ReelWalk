import { describe, expect, it } from "vitest";
import { readSoundCommand, toTimelineCommand } from "./sound-commands";

const context = { dropMs: 12_000, dropSongMsFromMusic: null, sourceStartMs: 0, reelMs: 20_000 };

describe("sound commands over HTTP", () => {
  it("reads a command from the body or from a `command` wrapper, strictly", () => {
    expect(readSoundCommand({ command: { type: "autoSfx" } })).toEqual({ ok: true, command: { type: "autoSfx" } });
    expect(readSoundCommand({ type: "dropOnCut", cut: 3 })).toEqual({ ok: true, command: { type: "dropOnCut", cut: 3 } });
    expect(readSoundCommand({ type: "autoSfx", options: { ambience: { c1: "fire", c2: null }, whooshHardCuts: true } }).ok).toBe(true);
    expect(readSoundCommand({ type: "autoSfx", options: { ambience: { c1: "lava" } } }).ok).toBe(false);
    expect(readSoundCommand({ type: "autoSfx", extra: 1 }).ok).toBe(false);
    expect(readSoundCommand({ type: "setSfx", sfx: [{ id: "a", sound: "whoosh-1", atMs: 500 }] }).ok).toBe(true);
    expect(readSoundCommand({ type: "setSfx", sfx: [{ id: "a", sound: "kazoo", atMs: 500 }] }).ok).toBe(false);
    expect(readSoundCommand({ type: "dropOnCut", cut: 0 }).ok).toBe(false);
    expect(readSoundCommand(null)).toMatchObject({ ok: false });
  });

  it("names the field that failed", () => {
    const read = readSoundCommand({ type: "dropOnCut", cut: "three" });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.message).toMatch(/^cut: /);
  });

  it("tells auto placement where the drop falls in reel time", () => {
    const made = toTimelineCommand({ type: "autoSfx" }, context);
    expect(made).toEqual({ ok: true, command: { type: "autoSfx", options: { dropMs: 12_000 } } });
    // A reel that starts 5 s into the song: the drop is 7 s in.
    expect(toTimelineCommand({ type: "autoSfx" }, { ...context, sourceStartMs: 5000 })).toEqual({ ok: true, command: { type: "autoSfx", options: { dropMs: 7000 } } });
    // A drop past the end of the reel is no reveal.
    expect(toTimelineCommand({ type: "autoSfx" }, { ...context, reelMs: 10_000 })).toEqual({ ok: true, command: { type: "autoSfx", options: { dropMs: null } } });
    // A reveal given by hand wins.
    expect(toTimelineCommand({ type: "autoSfx", options: { revealMs: 4000 } }, context)).toEqual({ ok: true, command: { type: "autoSfx", options: { revealMs: 4000 } } });
  });

  it("fills the drop's song time from the analysis, then from the music, else refuses", () => {
    expect(toTimelineCommand({ type: "dropOnCut", cut: 2 }, context)).toEqual({ ok: true, command: { type: "dropOnCut", cut: 2, dropSongMs: 12_000 } });
    expect(toTimelineCommand({ type: "dropOnCut", cut: 2, dropSongMs: 9000 }, context)).toEqual({ ok: true, command: { type: "dropOnCut", cut: 2, dropSongMs: 9000 } });
    expect(toTimelineCommand({ type: "dropOnCut", cut: 2 }, { ...context, dropMs: null, dropSongMsFromMusic: 8000 })).toEqual({ ok: true, command: { type: "dropOnCut", cut: 2, dropSongMs: 8000 } });
    const refused = toTimelineCommand({ type: "dropOnCut", cut: 2 }, { ...context, dropMs: null });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toMatch(/analysis/);
  });
});
