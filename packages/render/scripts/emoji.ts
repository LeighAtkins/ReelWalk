/**
 * Emoji in a title come out coloured, not as empty boxes (ADR 0039 note). The
 * worker's Chrome has no emoji font of its own; the composition bundles Noto
 * Color Emoji (SIL OFL 1.1) and the worker image installs fonts-noto-color-emoji.
 *
 *   FFMPEG=… tsx scripts/emoji.ts [out.png]
 *
 * Draws "🚩 ❤️ 🏠" in white on black with `renderReelStills`, the composition
 * the preview and the export share. White lettering and a tofu outline have no
 * colour, so every saturated pixel is emoji: the script needs several thousand
 * of them, in three separate groups of columns (one per emoji). Writes the frame
 * to out.png (default ../../docs/adr/assets/emoji-render.png); exits 1 on tofu.
 * Needs ffmpeg and a Chrome the renderer can use, like render-smoke.ts.
 */
import { mkdir, mkdtemp, rm, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTimeline } from "@reelwalk/core";
import { renderReelStills } from "../src/render-reel";
import type { ReelAsset } from "../src/reel/types";
import { ffmpeg, readImage } from "./acceptance/ffmpeg";
import { serve } from "./smoke-fixture";

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const out = path.resolve(process.argv[2] ?? path.join(here, "../../../docs/adr/assets/emoji-render.png"));
  const media = await mkdtemp(path.join(os.tmpdir(), "reelwalk-emoji-"));
  const server = await serve(media);
  try {
    await ffmpeg(["-f", "lavfi", "-i", "color=c=black:size=1080x1920:rate=30:duration=2", "-pix_fmt", "yuv420p", "-c:v", "libx264", path.join(media, "black.mp4")]);
    const assets: Record<string, ReelAsset> = { black: { src: `${server.url}/black.mp4`, kind: "VIDEO" } };
    const timeline = parseTimeline({
      version: 1,
      clips: [{ id: "c", assetId: "black", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000 }],
      texts: [{ id: "t", text: "ABC 🚩 ❤️ 🏠", startMs: 0, endMs: 2000, x: 0.5, y: 0.45, style: (process.env.STYLE ?? "headline") as "headline", size: 1.2, animation: "none" }],
      music: null,
    });
    const stills = await renderReelStills({ timeline, assets, frames: [30], dir: media, width: 1080, timeoutMs: 60_000 });
    const png = stills.get(30);
    if (!png) throw new Error("no frame rendered");
    await mkdir(path.dirname(out), { recursive: true });
    await copyFile(png, out);

    const image = await readImage(png);
    const columns = new Array<number>(image.width).fill(0);
    let coloured = 0;
    for (let i = 0; i < image.width * image.height; i++) {
      const [r, g, b] = [image.data[i * 3], image.data[i * 3 + 1], image.data[i * 3 + 2]];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 60) { coloured++; columns[i % image.width]++; }
    }
    let groups = 0, gap = Infinity;
    for (const count of columns) {
      if (count > 0) { if (gap > 12) groups++; gap = 0; } else gap++;
    }
    console.log(`coloured pixels: ${coloured}; emoji groups: ${groups}; frame: ${out}`);
    if (coloured < 3000 || groups < 3) {
      console.error("FAIL: emoji did not draw in colour (tofu?)");
      process.exitCode = 1;
    } else console.log("OK");
  } finally {
    server.close();
    await rm(media, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
