/**
 * A synthetic shot for the matte tests (ADR 0051): a textured wall with a red
 * "presenter" blob that moves across it, and a fake segmenter that answers on
 * a coarse 32×32 grid the way the real 256×256 model answers on 1080×1920.
 * No real person clip is checked in (Pexels needs a browser to download);
 * the rule under test does not depend on what the segmenter sees.
 */
import { createHash } from "node:crypto";
import type { Mask } from "../src/reel/matte-refine";
import type { PersonFrame, Rect, Rgba } from "../src/reel/matte-core";

export const FW = 96, FH = 160;

export function blobCentre(f: number): { x: number; y: number } {
  return { x: 30 + 3 * f, y: 70 + 2 * f };
}

/** Frame f of the shot: a wall with texture, and the blob (radius 18) at `blobCentre(f)`. */
export function shotFrame(f: number, options: { blob?: boolean } = {}): Rgba {
  const data = new Uint8ClampedArray(FW * FH * 4);
  const { x: bx, y: by } = blobCentre(f);
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const i = (y * FW + x) * 4;
    const wall = 90 + ((x * 7 + y * 13) % 40);
    const inBlob = options.blob !== false && (x - bx) ** 2 + (y - by) ** 2 < 18 * 18;
    // The blob carries its own texture (a ring and a spot) so the tracker has something to lock on.
    const ring = Math.abs(Math.hypot(x - bx, y - by) - 9) < 2 ? 60 : 0;
    const spot = (x - bx - 4) ** 2 + (y - by + 5) ** 2 < 9 ? 80 : 0;
    data[i] = inBlob ? 220 - ring : wall;
    data[i + 1] = inBlob ? 40 + spot : wall;
    data[i + 2] = inBlob ? 40 : wall + 10;
    data[i + 3] = 255;
  }
  return { data, width: FW, height: FH };
}

const GRID = 32;

/** A fake selfie segmenter: the redness of the picture (or crop) sampled on a 32×32 grid, as a soft confidence. */
export function fakeSegment(pixels: Rgba, crop: Rect | null): Mask {
  const r = crop ?? { x: 0, y: 0, width: pixels.width, height: pixels.height };
  const data = new Float32Array(GRID * GRID);
  for (let gy = 0; gy < GRID; gy++) for (let gx = 0; gx < GRID; gx++) {
    const x = Math.min(pixels.width - 1, Math.floor(r.x + ((gx + 0.5) * r.width) / GRID));
    const y = Math.min(pixels.height - 1, Math.floor(r.y + ((gy + 0.5) * r.height) / GRID));
    const i = (y * pixels.width + x) * 4;
    const redness = (pixels.data[i] - pixels.data[i + 1]) / 255;
    data[gy * GRID + gx] = Math.max(0, Math.min(1, 0.5 + (redness - 0.3) * 3));
  }
  return { data, width: GRID, height: GRID };
}

export function personFrame(f: number): PersonFrame {
  const pixels = shotFrame(f);
  return { pixels, segment: (crop) => fakeSegment(pixels, crop) };
}

export function hash(bytes: Uint8ClampedArray | Float32Array): string {
  return createHash("sha256").update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest("hex");
}
