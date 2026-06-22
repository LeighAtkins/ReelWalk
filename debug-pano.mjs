#!/usr/bin/env node
/**
 * Simple test to verify what path the code takes
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// Test if image is recognized as panorama
function isImage(filename) {
  return /\.(jpe?g|png|webp)$/i.test(filename);
}

function probeMedia(filePath) {
  const out = execFileSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,codec_name,duration",
    "-of", "csv=p=0",
    filePath,
  ], { encoding: "utf-8" }).trim();
  const parts = out.split(",");
  return {
    codec: parts[0],
    width: parseInt(parts[1], 10),
    height: parseInt(parts[2], 10),
    duration: parts[3] ? parseFloat(parts[3]) : 0,
  };
}

// Test the detection logic
const info = probeMedia("/tmp/test-pano.jpg");
const isPano = isImage("/tmp/test-pano.jpg") && info.width / info.height >= 1.8;

console.log(`[debug] isImage(/tmp/test-pano.jpg): ${isImage("/tmp/test-pano.jpg")}`);
console.log(`[debug] info: ${JSON.stringify(info)}`);
console.log(`[debug] info.width / info.height: ${info.width / info.height}`);
console.log(`[debug] isPano result: ${isPano}`);