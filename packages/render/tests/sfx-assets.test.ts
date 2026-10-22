import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SFX_SOUND_IDS, SFX_SOUNDS, type Timeline } from "@reelwalk/core";
import { sfxAssets } from "../src/reel/sfx-assets";

const here = path.dirname(fileURLToPath(import.meta.url));
const renderPublic = path.join(here, "..", "public", "sfx");
const webPublic = path.join(here, "..", "..", "..", "apps", "web", "public", "sfx");

/** A 16-bit mono WAV header's sample rate and data length. */
function wavInfo(file: string): { sampleRate: number; channels: number; bits: number; frames: number } {
  const bytes = readFileSync(file);
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  const bits = bytes.readUInt16LE(34);
  const dataLength = bytes.readUInt32LE(40);
  return { sampleRate, channels, bits, frames: dataLength / (channels * (bits / 8)) };
}

describe("bundled sound set (ADR 0066)", () => {
  it("has every sound the schema names, as mono 16-bit 32 kHz WAV of the documented length", () => {
    for (const id of SFX_SOUND_IDS) {
      const spec = SFX_SOUNDS[id];
      const info = wavInfo(path.join(renderPublic, spec.file));
      expect(info.channels, id).toBe(1);
      expect(info.bits, id).toBe(16);
      expect(info.sampleRate, id).toBe(32_000);
      expect(Math.round((info.frames / info.sampleRate) * 1000), id).toBe(spec.durationMs);
    }
  });

  it("serves the same bytes from the web app's public dir as from the render bundle", () => {
    for (const id of SFX_SOUND_IDS) {
      const file = SFX_SOUNDS[id].file;
      expect(statSync(path.join(webPublic, file)).size, file).toBe(statSync(path.join(renderPublic, file)).size);
      expect(readFileSync(path.join(webPublic, file)).equals(readFileSync(path.join(renderPublic, file))), file).toBe(true);
    }
  });

  it("lists only the sounds a reel uses, under sfx:<id>, from the public path each environment serves", () => {
    const timeline = { sfx: [{ id: "a", sound: "whoosh-2", atMs: 0 }, { id: "b", sound: "fire", atMs: 0, durationMs: 4000 }, { id: "c", sound: "whoosh-2", atMs: 900 }] } as Pick<Timeline, "sfx">;
    expect(sfxAssets(timeline)).toEqual({ "sfx:whoosh-2": { src: "sfx/whoosh-2.wav", kind: "AUDIO" }, "sfx:fire": { src: "sfx/fire.wav", kind: "AUDIO" } });
    expect(Object.keys(sfxAssets({ sfx: [] }))).toEqual([]);
    expect(sfxAssets(timeline, (file) => `/sfx/${file}`)["sfx:fire"]?.src).toBe("/sfx/fire.wav");
  });
});
