#!/usr/bin/env node
/**
 * Simple test to verify Remotion panning works
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

// Create a simple Remotion test file
const remotionCode = `
import React from "react";
import { 
  AbsoluteFill, 
  Img, 
  useCurrentFrame, 
  useVideoConfig,
  interpolate 
} from "remotion";

export const MyVideo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  
  // Simple zoom animation
  const scale = interpolate(frame, [0, 30], [1, 1.1], {
    extrapolateRight: "clamp"
  });
  
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <div style={{ 
        fontSize: 100, 
        color: "white",
        transform: \`scale(\${scale})\`,
        textAlign: "center"
      }}>
        Hello World
      </div>
    </AbsoluteFill>
  );
};
`;

// Write the test file
writeFileSync("test-remotion.tsx", remotionCode);

// Try to render with Remotion
console.log("Testing Remotion render...");
try {
  execFileSync("npx", [
    "remotion",
    "render",
    "test-remotion.tsx",
    "test-output.mp4",
    "--duration-in-frames",
    "60",
    "--codec",
    "h264",
    "--pixel-format",
    "yuv420p"
  ], {
    stdio: "inherit"
  });
  
  console.log("✅ Remotion render successful!");
  
  // Check if file was created
  const stats = require("fs").statSync("test-output.mp4");
  console.log(`📹 Output file: ${stats.size} bytes`);
  
} catch (error) {
  console.error("❌ Remotion render failed:", error);
} finally {
  // Cleanup
  require("fs").unlinkSync("test-remotion.tsx");
  const outputExists = require("fs").existsSync("test-output.mp4");
  if (outputExists) {
    require("fs").unlinkSync("test-output.mp4");
  }
}