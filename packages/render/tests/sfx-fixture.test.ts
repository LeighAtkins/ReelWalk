import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loudnormFilter, loudnormMeasureFilter, LOUDNESS_TARGET, measureLoudness, parseLoudnorm, parseTimeline, truePeakDb, type LoudnessMeasure } from "@reelwalk/core";
import { ffmpegBin, ffprobeBin } from "../scripts/acceptance/ffmpeg";
import { sfxAssets } from "../src/reel/sfx-assets";
import { renderReel } from "../src/render-reel";

/**
 * The sound design rendered for real (ADR 0066): a six-second reel of two
 * stills with a whoosh into the cut, a soft impact on it and room tone
 * under everything, exported by the shared composition, then its AAC track
 * measured with ffmpeg's loudnorm (the worker's own meter) and with the
 * pure BS.1770 code in @reelwalk/core, and levelled by the worker's two
 * loudnorm passes. Needs a browser the renderer can use and ffmpeg
 * (FFMPEG / FFPROBE name the binaries; Remotion's bundled ffmpeg is
 * enough), so it runs only with SFX_FIXTURE=1; `pnpm check` skips it.
 */

const run = promisify(execFile);
const enabled = process.env.SFX_FIXTURE === "1";

// A 1×1 grey PNG: the picture does not matter, the sound does.
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** The export's audio as stereo 48 kHz floats, through a 16-bit WAV (Remotion's ffmpeg has no raw float muxer). */
async function decodeStereo(file: string, dir: string): Promise<{ left: Float32Array; right: Float32Array }> {
  const wav = path.join(dir, "audio.wav");
  await run(ffmpegBin(), ["-v", "error", "-y", "-i", file, "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", "-f", "wav", wav]);
  const bytes = await readFile(wav);
  // Walk the RIFF chunks to the data chunk; ffmpeg writes a LIST chunk before it.
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "data") {
      const frames = Math.floor(Math.min(size, bytes.length - offset - 8) / 4);
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        left[i] = bytes.readInt16LE(offset + 8 + i * 4) / 32768;
        right[i] = bytes.readInt16LE(offset + 10 + i * 4) / 32768;
      }
      return { left, right };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in the decoded WAV");
}

/** ffmpeg's own BS.1770 measurement, as the worker reads it: loudnorm's first pass. */
async function measureWithFfmpeg(file: string): Promise<LoudnessMeasure> {
  const stderr = await run(ffmpegBin(), ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", loudnormMeasureFilter(), "-f", "null", "-"]).then(
    (result) => result.stderr,
    (error: { stderr?: string }) => error.stderr ?? "",
  );
  const measured = parseLoudnorm(stderr);
  if (!measured) throw new Error(`loudnorm printed no measurement:\n${stderr.slice(-800)}`);
  return measured;
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

      // 2. Our BS.1770 agrees with ffmpeg's, and the track is not silent. On steady tones and bursts the two agree within
      // 0.1 LU (checked at 40 Hz to 10 kHz); on this near-silent reel with one low impact the gating decisions differ by up
      // to about 2 LU (the worker levels with ffmpeg, so only the trace's display is affected), hence the wider tolerance.
      const raw = await decodeStereo(output, dir);
      const ours = measureLoudness([raw.left, raw.right], 48_000, 50);
      const ourPeak = truePeakDb([raw.left, raw.right]);
      const theirs = await measureWithFfmpeg(output);
      expect(Number.isFinite(ours.integrated)).toBe(true);
      expect(ours.integrated).toBeGreaterThan(-45);
      expect(Math.abs(ours.integrated - Number(theirs.input_i))).toBeLessThanOrEqual(3);
      expect(Math.abs(ourPeak - Number(theirs.input_tp))).toBeLessThanOrEqual(1);

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
      const levelled = path.join(dir, "levelled.mp4");
      await run(ffmpegBin(), ["-v", "error", "-y", "-i", output, "-c:v", "copy", "-af", loudnormFilter(theirs), "-ar", "48000", "-c:a", "aac", "-b:a", "192k", levelled]);
      const after = await measureWithFfmpeg(levelled);
      console.log(
        `sfx fixture: raw ${ours.integrated.toFixed(1)} LUFS / ${ourPeak.toFixed(1)} dBTP (ffmpeg ${theirs.input_i} / ${theirs.input_tp}), loudest block ends ${loudestEndMs} ms, room tone ${Math.max(...early).toFixed(1)} LUFS, levelled ${after.input_i} LUFS / ${after.input_tp} dBTP`,
      );
      // The ceiling binds first when the gain to the target would push the true peak over it: then the level stops short of
      // the target (loudnorm keeps the mix linear, ADR 0045) and only the ceiling is guaranteed.
      const gainToTarget = LOUDNESS_TARGET.I - Number(theirs.input_i);
      const ceilingBinds = Number(theirs.input_tp) + gainToTarget > LOUDNESS_TARGET.TP;
      expect(Number(after.input_tp)).toBeLessThanOrEqual(LOUDNESS_TARGET.TP + 0.5);
      if (ceilingBinds) expect(Number(after.input_i)).toBeLessThanOrEqual(LOUDNESS_TARGET.I + 1);
      else expect(Math.abs(Number(after.input_i) - LOUDNESS_TARGET.I)).toBeLessThanOrEqual(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
