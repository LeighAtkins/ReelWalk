#!/usr/bin/env node
/**
 * Simple Remotion CLI wrapper for ReelWalk
 *
 * Uses npx remotion render instead of embedded runtime
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    input: { type: "string", short: "i" },
    output: { type: "string", short: "o" },
    caption: { type: "string", default: "Task 01 stub render" },
    brand: { type: "string", default: "ReelWalk" },
  },
  strict: true,
});

const { input, output, caption, brand } = values;

if (!input || !output) {
  console.error("Usage: node render-remotion.mjs --input <path> --output <path> [--caption text] [--brand text]");
  process.exit(1);
}

console.log(`[remotion] input: ${input}`);
console.log(`[remotion] output: ${output}`);
console.log(`[remotion] caption: ${caption}`);
console.log(`[remotion] brand: ${brand}`);

const workdir = process.cwd();
const inputFile = require("path").basename(input);

// Create a simple remotion render configuration
const config = {
  id: "StubReel",
  width: 1080,
  height: 1920,
  fps: 30,
  durationInFrames: 150,
  inputProps: {
    inputVideo: inputFile,
    caption,
    brand,
  },
};

const configPath = require("path").join(workdir, "remotion-config.json");
require("fs").writeFileSync(configPath, JSON.stringify(config));

console.log("[remotion] rendering...");
const startTime = Date.now();

try {
  // Use Remotion CLI to render
  execFileSync("npx", [
    "remotion",
    "render",
    "@reelwalk/render/src/index.ts",
    output,
    "--concurrency",
    "4",
    "--codec",
    "h264",
    "--pixel-format",
    "yuv420p",
    "--x264-preset",
    "veryfast",
    "--crf",
    "22",
    "--config",
    configPath,
  ], {
    stdio: "inherit",
    cwd: require("path").join(__dirname, "..", "..", "packages", "render"),
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[remotion] done in ${elapsed}s → ${output}`);
} catch (error) {
  console.error(`[remotion] failed:`, error);
  process.exit(1);
} finally {
  require("fs").unlinkSync(configPath);
}