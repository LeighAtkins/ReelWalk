import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { applyColorMatchToRgba, colorStatsFromRgba, lookDistance, matchTransform, type ColorStats } from "@reelwalk/core";

/**
 * The colour match end to end over decoded pictures (ADR 0070): three
 * synthetic rooms of one scene shot "warm", "cool" and "flat", measured the
 * way the server measures a poster (sharp → RGBA → statistics), matched to
 * the warm one, and measured again. With LOOK_STRIP_OUT set to a file path,
 * the before/after frame strip is written there as a PNG for the ADR.
 */
const WIDTH = 90, HEIGHT = 160;

type Cast = { name: string; gain: [number, number, number]; lift: number; flatten: number };
const CASTS: Cast[] = [
  { name: "warm", gain: [1.1, 1.0, 0.82], lift: 0.04, flatten: 0 },
  { name: "cool", gain: [0.8, 0.9, 1.15], lift: -0.06, flatten: 0 },
  { name: "flat", gain: [1, 1, 1], lift: 0.02, flatten: 0.5 },
];

/** One room: a lit wall fading down to a darker floor, a bright window and a dark sofa, under a cast. */
function room(cast: Cast): Uint8ClampedArray {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const t = y / HEIGHT;
      let r = 0.86 - 0.5 * t, g = 0.82 - 0.5 * t, b = 0.76 - 0.5 * t;
      if (x > 50 && x < 80 && y > 20 && y < 70) { r = 0.98; g = 0.97; b = 0.95; }
      if (x > 8 && x < 48 && y > 100 && y < 130) { r = 0.22; g = 0.2; b = 0.19; }
      const grey = (r + g + b) / 3;
      const mix = (value: number) => value * (1 - cast.flatten) + grey * cast.flatten;
      const px = [mix(r) * cast.gain[0] + cast.lift, mix(g) * cast.gain[1] + cast.lift, mix(b) * cast.gain[2] + cast.lift];
      const i = (y * WIDTH + x) * 4;
      data[i] = Math.round(Math.min(1, Math.max(0, px[0])) * 255);
      data[i + 1] = Math.round(Math.min(1, Math.max(0, px[1])) * 255);
      data[i + 2] = Math.round(Math.min(1, Math.max(0, px[2])) * 255);
      data[i + 3] = 255;
    }
  }
  return data;
}

async function png(rgba: Uint8ClampedArray): Promise<Buffer> {
  return sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toBuffer();
}

/** The server's measurement path: decode, RGBA, statistics. */
async function measure(file: Buffer): Promise<{ stats: ColorStats; rgba: Uint8ClampedArray }> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  return { stats: colorStatsFromRgba(rgba, info.width, info.height), rgba };
}

describe("colour match on decoded pictures", () => {
  it("brings three mismatched rooms within a cut's tolerance of the reference, and writes the strip", async () => {
    const files = await Promise.all(CASTS.map((cast) => png(room(cast))));
    const before = await Promise.all(files.map(measure));
    const reference = before[0].stats;
    const distancesBefore = before.map(({ stats }) => lookDistance(stats, reference));
    // The casts are plainly different to start with (0.03 shows at a cut).
    expect(distancesBefore[1]).toBeGreaterThan(0.06);
    expect(distancesBefore[2]).toBeGreaterThan(0.03);

    const after = before.map(({ stats, rgba }) => {
      const match = matchTransform(stats, reference);
      const out = new Uint8ClampedArray(rgba);
      applyColorMatchToRgba(match, out);
      return { match, rgba: out, stats: colorStatsFromRgba(out, WIDTH, HEIGHT) };
    });
    const distancesAfter = after.map(({ stats }) => lookDistance(stats, reference));
    for (const i of [1, 2]) {
      expect(distancesAfter[i]).toBeLessThan(0.012);
      expect(distancesAfter[i]).toBeLessThan(distancesBefore[i] * 0.3);
      // Contrast is matched too: the spread of luma comes to the reference's.
      expect(Math.abs(after[i].stats.std[0] - reference.std[0])).toBeLessThan(0.02);
    }
    // The reference maps onto itself.
    expect(distancesAfter[0]).toBeLessThan(0.002);

    const out = process.env.LOOK_STRIP_OUT;
    if (out) {
      const gap = 6, label = 18;
      const stripWidth = CASTS.length * WIDTH + (CASTS.length + 1) * gap;
      const stripHeight = 2 * (HEIGHT + label) + 3 * gap;
      const tiles = await Promise.all([...before.map((entry) => entry.rgba), ...after.map((entry) => entry.rgba)].map(png));
      const composites = tiles.map((input, index) => {
        const row = Math.floor(index / CASTS.length), column = index % CASTS.length;
        return { input, left: gap + column * (WIDTH + gap), top: gap + label + row * (HEIGHT + label + gap) };
      });
      const text = (content: string, x: number, y: number) => `<text x="${x}" y="${y}" font-family="sans-serif" font-size="11" fill="#ddd">${content}</text>`;
      const labels = [
        text("before: three casts of one room", gap, 13),
        text(`after: matched to ${CASTS[0].name} (${distancesAfter.slice(1).map((d) => d.toFixed(3)).join(", ")})`, gap, gap + label + HEIGHT + gap + 13),
      ].join("");
      const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${stripWidth}" height="${stripHeight}">${labels}</svg>`);
      const strip = await sharp({ create: { width: stripWidth, height: stripHeight, channels: 4, background: "#1a1a1a" } })
        .composite([...composites, { input: svg, left: 0, top: 0 }])
        .png()
        .toBuffer();
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, strip);
    }
  });
});
