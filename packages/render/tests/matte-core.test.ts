import { describe, expect, it } from "vitest";
import { describeTaps, MATTE_INPUTS, MATTE_VERSION, fnv1a64, objectRaw, PersonMatteRule, personRaw, trackTaps, type PersonFrame } from "../src/reel/matte-core";
import { toAlpha, Workspace } from "../src/reel/matte-refine";
import type { Gray } from "../src/reel/point-track";
import { blobCentre, fakeSegment, FH, FW, hash, personFrame, shotFrame } from "./matte-fixture";

const FRAMES = 12;
const key = (f: number) => `shot|${f}`;
const frameOf = (k: string) => Number(k.split("|")[1]);

/** Mattes `order` with `rule`, returning each frame's alpha hash by frame number, and how many pictures were read. */
async function run(order: number[], rule = new PersonMatteRule(FW, FH)): Promise<{ hashes: Map<number, string>; reads: number }> {
  const hashes = new Map<number, string>();
  let reads = 0;
  const read = async (k: string): Promise<PersonFrame> => { reads++; return personFrame(frameOf(k)); };
  for (const f of order) {
    const alpha = await rule.matte(key(f), f > 0 ? key(f - 1) : null, read);
    if (!alpha) throw new Error(`no matte for frame ${f}`);
    hashes.set(f, hash(alpha));
  }
  return { hashes, reads };
}

function seededShuffle(n: number, seed: number): number[] {
  const out = Array.from({ length: n }, (_, i) => i);
  let s = seed;
  for (let i = n - 1; i > 0; i--) { s = (s * 1103515245 + 12345) % 2 ** 31; const j = s % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

const inOrder = (hashes: Map<number, string>) => Array.from({ length: FRAMES }, (_, f) => hashes.get(f));

describe("the person matte rule (ADR 0051)", () => {
  it("gives the same pixels for every frame whatever order the frames are asked in", async () => {
    const sequential = inOrder((await run(Array.from({ length: FRAMES }, (_, f) => f))).hashes);
    const reverse = inOrder((await run(Array.from({ length: FRAMES }, (_, f) => FRAMES - 1 - f))).hashes);
    const scrub = inOrder((await run(seededShuffle(FRAMES, 7))).hashes);
    const repeated = inOrder((await run([5, 5, 0, 11, 4, 5, 6, 3, 2, 1, 7, 8, 9, 10, 11, 0])).hashes);
    // Parallel render pages: each frame on a fresh page, and two pages splitting the shot.
    const pages = new Map<number, string>();
    for (let f = 0; f < FRAMES; f++) pages.set(f, (await run([f])).hashes.get(f)!);
    const half = new Map([...(await run([0, 1, 2, 3, 4, 5])).hashes, ...(await run([6, 7, 8, 9, 10, 11])).hashes]);
    expect(new Set(sequential).size).toBe(FRAMES); // the blob moves: every frame differs
    expect(reverse).toEqual(sequential);
    expect(scrub).toEqual(sequential);
    expect(repeated).toEqual(sequential);
    expect(inOrder(pages)).toEqual(sequential);
    expect(inOrder(half)).toEqual(sequential);
  });

  it("settles against the previous frame, so skipping it (the old preview) would differ", async () => {
    const settled = (await run([5])).hashes.get(5)!;
    const ws = new Workspace();
    const raw = new Float32Array(FW * FH);
    personRaw(shotFrame(5), (crop) => fakeSegment(shotFrame(5), crop), ws, raw);
    const unsettled = hash(toAlpha({ data: raw, width: FW, height: FH }, 0.35, 0.65));
    expect(unsettled).not.toBe(settled);
    // The first frame of a shot has nothing to settle against.
    personRaw(shotFrame(0), (crop) => fakeSegment(shotFrame(0), crop), ws, raw);
    expect(hash(toAlpha({ data: raw, width: FW, height: FH }, 0.35, 0.65))).toBe((await run([0])).hashes.get(0));
  });

  it("reads each picture once when played in order, and the previous one first on a seek", async () => {
    expect((await run(Array.from({ length: FRAMES }, (_, f) => f))).reads).toBe(FRAMES);
    const order: string[] = [];
    const rule = new PersonMatteRule(FW, FH);
    await rule.matte(key(8), key(7), async (k) => { order.push(k); return personFrame(frameOf(k)); });
    expect(order).toEqual([key(7), key(8)]);
  });

  it("returns null when the segmenter gives no mask for the frame", async () => {
    const rule = new PersonMatteRule(FW, FH);
    const alpha = await rule.matte(key(3), key(2), async (k) => {
      const frame = personFrame(frameOf(k));
      return frameOf(k) === 3 ? { ...frame, segment: () => null } : frame;
    });
    expect(alpha).toBeNull();
  });

  it("allocates its working buffers once: nothing new over 100 frames", async () => {
    const rule = new PersonMatteRule(FW, FH);
    const read = async (k: string) => personFrame(frameOf(k) % 20);
    for (let f = 0; f < 3; f++) await rule.matte(key(f), f ? key(f - 1) : null, read);
    const warm = rule.ws.allocations;
    const alpha = rule.alpha;
    for (let f = 3; f < 103; f++) {
      const out = await rule.matte(key(f), key(f - 1), read);
      expect(out).toBe(alpha);
    }
    expect(warm).toBeGreaterThan(0);
    expect(rule.ws.allocations).toBe(warm);
  });
});

describe("the object matte", () => {
  const pixels = shotFrame(4);
  const touch = (point: { x: number; y: number }) => fakeSegment(pixels, { x: Math.floor(point.x * FW) - 16, y: Math.floor(point.y * FH) - 16, width: 32, height: 32 });

  it("fails closed when a tap in the picture gets no mask, and is empty when every tap has left", () => {
    const ws = new Workspace();
    const out = new Float32Array(FW * FH).fill(0.5);
    expect(objectRaw(pixels, () => null, [{ x: 0.5, y: 0.5 }], ws, out)).toBe("no-mask");
    expect(objectRaw(pixels, () => null, [{ x: 1.2, y: 0.5 }, { x: 0.3, y: -0.1 }], ws, out)).toBe("off-frame");
    expect(out.every((v) => v === 0)).toBe(true);
    const centre = blobCentre(4);
    expect(objectRaw(pixels, touch, [{ x: centre.x / FW, y: centre.y / FH }], ws, out)).toBe("ok");
    expect(out[Math.round(centre.y) * FW + Math.round(centre.x)]).toBeGreaterThan(0.5);
  });

  it("reuses its buffers over 100 frames", () => {
    const ws = new Workspace();
    const out = new Float32Array(FW * FH);
    const tap = [{ x: 0.4, y: 0.5 }];
    objectRaw(pixels, touch, tap, ws, out);
    const warm = ws.allocations;
    for (let i = 0; i < 100; i++) objectRaw(pixels, touch, tap, ws, out);
    expect(ws.allocations).toBe(warm);
  });
});

describe("taps carried by the tracker", () => {
  const gray = (f: number, blob = true): Gray => {
    const rgba = shotFrame(f, { blob });
    const data = new Float32Array(FW * FH);
    for (let i = 0; i < data.length; i++) data[i] = (0.299 * rgba.data[i * 4] + 0.587 * rgba.data[i * 4 + 1] + 0.114 * rgba.data[i * 4 + 2]) / 255;
    return { data, width: FW, height: FH };
  };
  const at = (f: number) => ({ x: blobCentre(f).x / FW, y: blobCentre(f).y / FH });

  it("follows an object that moves independently of the wall, and falls back to the wall when it is gone", () => {
    const ref = gray(0);
    // The wall does not move: its homography would leave the tap where it was tapped.
    const wall = [at(0)];
    const moved = trackTaps(ref, [at(0)], gray(6), wall);
    expect(moved.status).toEqual(["tracked"]);
    expect(Math.abs(moved.taps[0].x * FW - blobCentre(6).x)).toBeLessThan(1);
    expect(Math.abs(moved.taps[0].y * FH - blobCentre(6).y)).toBeLessThan(1);
    const gone = trackTaps(ref, [at(0)], gray(6, false), wall);
    expect(gone.status).toEqual(["lost"]);
    expect(gone.taps).toEqual(wall);
    expect(describeTaps(gone.status)).toBe("tracked 0/1; the rest follow the wall (tracker lost)");
    expect(describeTaps(moved.status)).toBe("tracked 1/1");
    expect(describeTaps(trackTaps(null, [at(0)], null, wall).status)).toBe("taps fixed (no pin)");
  });

  it("is the same answer whatever was tracked before (random access)", () => {
    const ref = gray(0);
    const a = trackTaps(ref, [at(0)], gray(9), [at(0)]);
    trackTaps(ref, [at(0)], gray(3), [at(0)]);
    const b = trackTaps(ref, [at(0)], gray(9), [at(0)]);
    expect(b).toEqual(a);
  });
});

describe("MATTE_VERSION", () => {
  it("is derived from every input and pinned here, so a change to any of them shows in review", () => {
    expect(MATTE_VERSION).toBe(`matte-1-${fnv1a64(JSON.stringify(MATTE_INPUTS))}`);
    expect(MATTE_VERSION).toMatchInlineSnapshot(`"matte-1-f860056dedacb91e"`);
    const changed = { ...MATTE_INPUTS, person: { ...MATTE_INPUTS.person, settle: 0.3 } };
    expect(`matte-1-${fnv1a64(JSON.stringify(changed))}`).not.toBe(MATTE_VERSION);
    expect(fnv1a64("")).toBe("cbf29ce484222325");
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
  });
});
