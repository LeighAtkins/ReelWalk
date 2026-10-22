import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loudnormFilter, loudnormMeasureFilter, LOUDNESS_TARGET, measureLoudness, parseLoudnorm, parseTimeline, truePeakDb } from "@reelwalk/core";
import { ffmpegBin, ffprobeBin } from "../scripts/acceptance/ffmpeg";
import { sfxAssets } from "../src/reel/sfx-assets";
import { renderReel } from "../src/render-reel";

/**
 * The sound design rendered for real (ADR 0066): a six-second reel of two
 * stills with a whoosh into the cut, a soft impact on it and room tone
 * under everything, exported by the shared composition, then its AAC track
 * measured with ffmpeg and with the pure BS.1770 code in @reelwalk/core,
 * and levelled by the worker's two loudnorm passes. Needs a browser the
 * renderer can use and ffmpeg (FFMPEG / FFPROBE name the binaries), so it
 * runs only with SFX_FIXTURE=1; `pnpm check` skips it.
 */

const run = promisify(execFile);
const enabled = process.env.SFX_FIXTURE === "1";

// A 1×1 grey PNG: the picture does not matter, the sound does.
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function decodeStereo(file: string): Promise<{ left: Float32Array; right: Float32Array }> {
  const { stdout } = await run(ffmpegBin(), ["-v", "error", "-i", file, "-vn", "-ac", "2", "-ar", "48000", "-f", "f32le", "pipe:1"], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  const bytes = Math.floor(stdout.byteLength / 4) * 4;
  const both = new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + bytes));
  const frames = Math.floor(both.length / 2);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = both[2 * i];
    right[i] = both[2 * i + 1];
  }
  return { left, right };
}

/** ffmpeg's own BS.1770 measurement: integrated loudness and true peak. */
async function ebur128(file: string): Promise<{ integrated: number; truePeak: number }> {
  const { stderr } = await run(ffmpegBin(), ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"]).catch((error: { stderr?: string }) => ({ stderr: error.stderr ?? "" }));
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const integrated = /I:\s+(-?[\d.]+) LUFS/.exec(summary);
  const peak = /Peak:\s+(-?[\d.]+) dBFS/.exec(summary);
  if (!integrated || !peak) throw new Error(`ebur128 printed no summary:\n${stderr.slice(-800)}`);
  return { integrated: Number(integrated[1]), truePeak: Number(peak[1]) };
}

describe.skipIf(!enabled)("sound design rendered and measured (SFX_FIXTURE=1)", () => {
  it("exports an AAC track with the sounds where the rule put them, agreeing with ffmpeg on loudness, levelled to the target", { timeout: 15 * 60_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "reelwalk-sfx-"));
    try {
      const timeline = parseTimeline({
        version: 1,
        music: null,
        clips: [
          { id: "a", assetId: "pixel", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 },
          { id: "b", assetId: "pixel", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000, transitionIn: "whip" },
        ],
        texts: [],
        sfx: [
          { id: "whoosh", sound: "whoosh-1", atMs: 2700, auto: true, reason: "whoosh on the whip into clip 2" },
          { id: "impact", sound: "impact-soft", atMs: 3000, auto: true, reason: "impact on the reveal" },
          { id: "room", sound: "room-tone", atMs: 0, durationMs: 6000, gain: 0.5, fadeInMs: 200, fadeOutMs: 400, auto: true, reason: "room under everything" },
        ],
      });
      const assets = { pixel: { src: PIXEL, kind: "IMAGE" as const }, ...sfxAssets(timeline) };
      const output = path.join(dir, "sfx.mp4");
      await renderReel({ timeline, assets, output, width: 720, concurrency: 2 });

      // 1. The export carries an AAC track of the reel's length.
      const { stdout } = await run(ffprobeBin(), ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", output]);
      const probed = JSON.parse(stdout) as { streams: { codec_type: string; codec_name: string }[]; format: { duration: string } };
      const audio = probed.streams.find((stream) => stream.codec_type === "audio");
      expect(audio?.codec_name).toBe("aac");
      expect(Number(probed.format.duration)).toBeGreaterThan(5.8);

      // 2. Our BS.1770 agrees with ffmpeg's within a loudness unit, and the track is not silent.
      const raw = await decodeStereo(output);
      const ours = measureLoudness([raw.left, raw.right], 48_000, 50);
      const theirs = await ebur128(output);
      expect(Number.isFinite(ours.integrated)).toBe(true);
      expect(ours.integrated).toBeGreaterThan(-45);
      expect(Math.abs(ours.integrated - theirs.integrated)).toBeLessThanOrEqual(1);
      expect(Math.abs(truePeakDb([raw.left, raw.right]) - theirs.truePeak)).toBeLessThanOrEqual(1);

      // 3. The loudest moment is the impact on the cut at 3.0 s (the whoosh peaks there too), not the room tone.
      const blocks = ours.blocks.lufs;
      let loudest = 0;
      blocks.forEach((value, index) => {
        if (value > blocks[loudest]) loudest = index;
      });
      // Block i covers the 400 ms ending at 400 + i × 50 ms.
      const loudestEndMs = 400 + loudest * ours.blocks.stepMs;
      expect(loudestEndMs).toBeGreaterThanOrEqual(2900);
      expect(loudestEndMs).toBeLessThanOrEqual(3600);
      // Room tone alone (the first second, before the whoosh) sits far under it.
      const early = blocks.slice(0, 12);
      expect(Math.max(...early)).toBeLessThan(blocks[loudest] - 12);

      // 4. The worker's two loudnorm passes, with the filter strings from core, land on the target.
      const measured = await run(ffmpegBin(), ["-hide_banner", "-nostats", "-i", output, "-vn", "-af", loudnormMeasureFilter(), "-f", "null", "-"]).then((result) => parseLoudnorm(result.stderr), (error: { stderr?: string }) => parseLoudnorm(error.stderr ?? ""));
      expect(measured).not.toBeNull();
      const levelled = path.join(dir, "levelled.mp4");
      await run(ffmpegBin(), ["-v", "error", "-y", "-i", output, "-c:v", "copy", "-af", loudnormFilter(measured!), "-ar", "48000", "-c:a", "aac", "-b:a", "192k", levelled]);
      const after = await ebur128(levelled);
      expect(Math.abs(after.integrated - LOUDNESS_TARGET.I)).toBeLessThanOrEqual(1);
      expect(after.truePeak).toBeLessThanOrEqual(LOUDNESS_TARGET.TP + 0.5);
      console.log(`sfx fixture: raw ${ours.integrated.toFixed(1)} LUFS (ffmpeg ${theirs.integrated}), peak block ends ${loudestEndMs} ms, levelled ${after.integrated} LUFS / ${after.truePeak} dBTP`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
