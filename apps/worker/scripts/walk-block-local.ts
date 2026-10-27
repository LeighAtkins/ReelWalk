// Walk the block (ADR 0093) on a local file, without storage or a database: the worker's solve and render as the steps
// run them. For checking a clip or the look by eye.
//
//   tsx scripts/walk-block-local.ts <video> <out-dir> [build=home] [altitudeM] [pin.json]
//
// Reads <out-dir>/solve.json if it is there (else solves into it), takes the suggested site (or pin.json), and writes
// <out-dir>/reveal-<build>.mp4 and pin-<build>.json. Needs python with opencv (BLOCK_PYTHON) and ffmpeg (FFMPEG_PATH).
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BUILD_PRESETS, initialPin, parseBlockSolve, scaleFromAltitude, type BlockPin, type BuildPreset } from "@reelwalk/core";
import { createAttemptScope } from "../src/lifecycle";
import { renderReveal, solveClip } from "../src/walk-block";

const [video, outDir, buildArg = "home", altitudeArg, pinFile] = process.argv.slice(2);
if (!video || !outDir) throw new Error("usage: walk-block-local.ts <video> <out-dir> [build] [altitudeM] [pin.json]");
const build = buildArg as BuildPreset;
if (!BUILD_PRESETS.includes(build)) throw new Error(`build must be one of ${BUILD_PRESETS.join(", ")}`);

const scope = createAttemptScope();
try {
  const solvePath = path.join(outDir, "solve.json");
  const raw = existsSync(solvePath) ? JSON.parse(await readFile(solvePath, "utf8")) : await solveClip(video, outDir, scope);
  const parsed = parseBlockSolve(raw);
  if (!parsed.ok) throw new Error(`refused: ${parsed.code}: ${parsed.message}`);
  const solve = parsed.solve;
  const scale: BlockPin["scale"] = altitudeArg ? { factor: scaleFromAltitude(solve, Number(altitudeArg)), basis: "stated" } : { factor: 1, basis: "assumed" };
  const pin: BlockPin = pinFile ? JSON.parse(await readFile(pinFile, "utf8")) : initialPin(solve, build, scale);
  await writeFile(path.join(outDir, `pin-${build}.json`), JSON.stringify(pin, null, 1));
  console.log("pin", JSON.stringify(pin));
  const started = Date.now();
  const out = path.join(outDir, `reveal-${build}.mp4`);
  const result = await renderReveal({ videoPath: video, solve, pin, outPath: out, scope, onProgress: (f) => process.stdout.write(` ${Math.round(f * 100)}%`) });
  console.log(`\n${out}: ${result.frames} frames in ${((Date.now() - started) / 1000).toFixed(1)} s`);
} finally {
  await scope.close();
}
