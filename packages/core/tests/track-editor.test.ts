import { afterEach, describe, expect, it } from "vitest";
import type { Clip } from "../src";
import { texturedFrame } from "./track-bench/synth";

/**
 * trackTextPathDetailed end to end (ADR 0052) with a stand-in <video> and
 * <canvas>: the "video" shows the benchmark texture panning 0.03 px per ms
 * at the tracking size, so the saved path can be checked against the truth.
 */
const SPEED = 0.03;
let seeks: number[] = [];

class FakeVideo {
  private listeners: Record<string, (() => void)[]> = {};
  private time = 0;
  crossOrigin = ""; preload = ""; muted = false; src = ""; duration = 10;
  // A 9:16 source at the tracking size: under Fill at zoom 1 the composition shows it exactly (ADR 0047 draws frames through the clip's presentation).
  videoWidth = 360; videoHeight = 640; playsInline = false;
  addEventListener(type: string, fn: () => void) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type: string, fn: () => void) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
  removeAttribute() { this.src = ""; }
  load() { if (this.src) setTimeout(() => this.emit("loadeddata"), 0); }
  get currentTime() { return this.time; }
  set currentTime(v: number) { this.time = v; seeks.push(v * 1000); setTimeout(() => this.emit("seeked"), 0); }
  private emit(type: string) { for (const fn of [...(this.listeners[type] ?? [])]) fn(); }
}

function stubDocument() {
  let shown: FakeVideo | null = null;
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({
      drawImage: (video: FakeVideo) => { shown = video; },
      setTransform: () => undefined, fillRect: () => undefined, save: () => undefined, restore: () => undefined, filter: "none", fillStyle: "#000",
      getImageData: (_x: number, _y: number, w: number, h: number) => {
        const gray = texturedFrame(w, h, [1, 0, (shown?.currentTime ?? 0) * 1000 * SPEED, 0, 1, 0, 0, 0, 1]);
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = gray.data[i]; data[i * 4 + 3] = 255; }
        return { data };
      },
    }),
  };
  (globalThis as { document?: unknown }).document = { createElement: (tag: string) => (tag === "video" ? new FakeVideo() : canvas) };
}

// Loaded at run time (vitest resolves the web app's "@/" alias); core's typecheck does not follow it into the web app.
type Detailed = (
  asset: never, clip: Clip, clipStartMs: number,
  text: { x: number; y: number; startMs: number; endMs: number; surface?: number[] },
  onProgress?: (fraction: number) => void,
) => Promise<{ error: string; reason?: string } | { path: { t: number; q?: number[]; o?: number }[]; pin: { fromMs: number; toMs: number }; confidence: number[] }>;
const FRAME_ANALYSIS = "@/components/editor/frame-analysis";
const load = async () => ((await import(/* @vite-ignore */ FRAME_ANALYSIS)) as { trackTextPathDetailed: Detailed }).trackTextPathDetailed;

afterEach(() => { delete (globalThis as { document?: unknown }).document; seeks = []; });

describe("trackTextPathDetailed", () => {
  it("samples the true end of a 250 ms window and times keyframes over the saved pin (regression)", async () => {
    stubDocument();
    const trackTextPathDetailed = await load();
    const clip = { assetId: "a", sourceStartMs: 0, sourceEndMs: 250, speed: 1 } as unknown as Clip;
    const surface = [0.3, 0.33, 0.7, 0.33, 0.7, 0.51, 0.3, 0.51];
    const progress: number[] = [];
    const result = await trackTextPathDetailed({ id: "a", url: "x", fileName: "x.mp4" } as never, clip, 0, { x: 0.5, y: 0.42, startMs: 0, endMs: 250, surface }, (f) => progress.push(f));
    if ("error" in result) throw new Error(result.error);
    expect(result.pin).toMatchObject({ fromMs: 0, toMs: 250 });
    expect(seeks.map((s) => Math.round(s))).toEqual([0, 83, 167, 250]);
    expect(result.path.map((p) => p.t)).toEqual([0, 0.3333, 0.6667, 1]);
    // Each keyframe's corners are where the surface is at that keyframe's time, within 0.5 px at 360 wide (8-bit frames, 4-decimal q); sampling at 0/100/200 ms with t = 0, 0.5, 1 would be ~1.5 px off.
    result.path.forEach((p) => {
      const ms = p.t * (result.pin.toMs - result.pin.fromMs) + result.pin.fromMs;
      expect(Math.abs(p.q![0] * 360 - (0.3 * 360 + ms * SPEED))).toBeLessThan(0.5);
    });
    expect(result.path.every((p) => p.o === undefined)).toBe(true);
    expect(result.confidence).toHaveLength(result.path.length);
    expect(progress.at(-1)).toBe(1);
  });

  it("says why it refused a blank surface", async () => {
    stubDocument();
    const trackTextPathDetailed = await load();
    const clip = { assetId: "a", sourceStartMs: 0, sourceEndMs: 1000, speed: 1 } as unknown as Clip;
    // A sliver too thin to hold features.
    const result = await trackTextPathDetailed({ id: "a", url: "x", fileName: "x.mp4" } as never, clip, 0, { x: 0.5, y: 0.4, startMs: 0, endMs: 1000, surface: [0.4, 0.4, 0.6, 0.4, 0.6, 0.402, 0.4, 0.402] });
    expect(result).toMatchObject({ reason: "too-few-features" });
    if ("error" in result) expect(result.error).toMatch(/^Could not follow this surface/);
  });
});
