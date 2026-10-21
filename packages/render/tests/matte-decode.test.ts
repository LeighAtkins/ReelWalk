import { describe, expect, it } from "vitest";
import { PersonMatteRule } from "../src/reel/matte-core";
import { CANCELLED, failureAction, personMatteFrame, SAME_TIME_S, SeekAborted, SeekTimeout, seekTo, SerialQueue } from "../src/reel/matte-decode";
import { fakeSegment, FH, FW, hash, shotFrame } from "./matte-fixture";

/**
 * A video element as far as seeking goes: a seek lands on a later tick (or when
 * `finish()` is called in manual mode), and the picture it holds is the one at
 * the time it last finished seeking to. Like a browser it clamps to the duration
 * (once known) and can keep time on a coarse timescale (`tick`, seconds).
 * It does not model whole decoded frames or colour.
 */
class FakeVideo {
  readyState = 4;
  error = null;
  seeking = false;
  picture = 0;
  seeks = 0;
  duration: number;
  private time = 0;
  private readonly mode: "auto" | "manual";
  private readonly tick: number;
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(mode: "auto" | "manual" = "auto", options: { duration?: number; tick?: number } = {}) {
    this.mode = mode; this.duration = options.duration ?? Infinity; this.tick = options.tick ?? 0;
  }
  private settle(value: number) {
    const clamped = Number.isFinite(this.duration) ? Math.min(value, this.duration) : value;
    return this.tick ? Math.floor(clamped / this.tick + 1e-9) * this.tick : clamped;
  }
  get currentTime() { return this.time; }
  set currentTime(value: number) {
    this.time = this.settle(value); this.seeking = true; this.seeks++;
    if (this.mode === "auto") setTimeout(() => this.finish(), 0);
  }
  finish() { this.time = this.settle(this.time); this.picture = this.time; this.seeking = false; this.emit("seeked"); }
  addEventListener(type: string, listener: () => void) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(listener); }
  removeEventListener(type: string, listener: () => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener(); }
  listenerCount() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}

const FPS = 30;
const FRAMES = 10;

/** The shot's picture at source time t: the blob moves continuously, 3 px per 1/30 s. */
function capture(video: FakeVideo) {
  const pixels = shotFrame(video.picture * FPS);
  return { pixels, segment: (crop: Parameters<typeof fakeSegment>[1]) => fakeSegment(pixels, crop) };
}

async function matte(rule: PersonMatteRule, video: FakeVideo, frame: number, speed: number): Promise<string> {
  const alpha = await personMatteFrame({
    rule, frame, scope: "clip", seconds: (n) => 0.2 + (n / FPS) * speed,
    seek: (t) => seekTo(video, t), capture: () => capture(video),
  });
  if (!alpha) throw new Error("no matte");
  // Left on this frame for the composite.
  expect(Math.abs(video.picture - (0.2 + (frame / FPS) * speed))).toBeLessThan(SAME_TIME_S);
  return hash(alpha);
}

describe("seeking a matte's decode (ADR 0051, review of PR #190)", () => {
  for (const speed of [0.25, 0.5, 1, 2]) {
    it(`gives the same alpha sequentially, scrubbed and on fresh pages at ${speed}×`, async () => {
      const sequential: string[] = [];
      { const rule = new PersonMatteRule(FW, FH), video = new FakeVideo(); for (let f = 0; f < FRAMES; f++) sequential.push(await matte(rule, video, f, speed)); }
      const scrubbed: string[] = [];
      { const rule = new PersonMatteRule(FW, FH), video = new FakeVideo(); for (const f of [7, 2, 3, 9, 0, 8, 1, 4, 6, 5]) scrubbed[f] = await matte(rule, video, f, speed); }
      const fresh: string[] = [];
      for (let f = 0; f < FRAMES; f++) fresh.push(await matte(new PersonMatteRule(FW, FH), new FakeVideo(), f, speed));
      expect(new Set(sequential).size).toBe(FRAMES);
      expect(scrubbed).toEqual(sequential);
      expect(fresh).toEqual(sequential);
    });
  }

  it("gives the same alpha in any order on a WebKit-like 1/600 s timescale at 0.25×", async () => {
    const make = () => new FakeVideo("auto", { tick: 1 / 600 });
    const sequential: string[] = [];
    { const rule = new PersonMatteRule(FW, FH), video = make(); for (let f = 0; f < FRAMES; f++) sequential.push(await matte(rule, video, f, 0.25)); }
    const fresh: string[] = [];
    for (let f = 0; f < FRAMES; f++) fresh.push(await matte(new PersonMatteRule(FW, FH), make(), f, 0.25));
    expect(new Set(sequential).size).toBe(FRAMES);
    expect(fresh).toEqual(sequential);
  });

  it("clamps a seek past the end of the file to its last picture (review of PR #190)", async () => {
    // A 149-frame 30 fps file; the clip's stored duration rounds up, and its last frame asks for 4.967 s.
    const duration = 149 / 30;
    const video = new FakeVideo("auto", { duration });
    await seekTo(video, 4.967, { timeoutMs: 200 });
    expect(video.picture).toBe(duration);
    // Before the metadata loads the duration is unknown; the browser clamps when it lands.
    const early = new FakeVideo("manual", { duration: NaN });
    const pending = seekTo(early, 4.967, { timeoutMs: 200 });
    early.duration = duration;
    early.finish();
    await pending;
    expect(early.picture).toBe(duration);
  });

  it("retries a slow seek in the editor, fails it in an export, and ignores superseded jobs", () => {
    const slow = new SeekTimeout("seek timed out");
    expect(failureAction(slow, false)).toBe("retry");
    expect(failureAction(slow, true)).toBe("fail");
    expect(failureAction(new SeekAborted("aborted"), true)).toBe("ignore");
    expect(failureAction(CANCELLED, false)).toBe("ignore");
    expect(failureAction(new Error("the segmenter returned no mask"), false)).toBe("fail");
  });

  it("does not take a nearby picture for the requested one", async () => {
    const video = new FakeVideo();
    await seekTo(video, 0.2);
    await seekTo(video, 0.2 + 1 / 120); // 8.3 ms later: a quarter-speed neighbour
    expect(video.picture).toBe(0.2 + 1 / 120);
    const seeks = video.seeks;
    await seekTo(video, 0.2 + 1 / 120); // confirmed: no second seek
    expect(video.seeks).toBe(seeks);
  });

  it("accepts Chrome's microsecond-truncated time as the picture asked for", async () => {
    const video = new FakeVideo("manual");
    const pending = seekTo(video, 61 / 30);
    (video as unknown as { time: number }).time = 2.033332; // what Chrome reads back
    video.finish();
    await pending;
    expect(video.picture).toBe(2.033332);
  });

  it("rejects an aborted seek, and the queue carries on", async () => {
    const video = new FakeVideo("manual");
    const queue = new SerialQueue();
    const controller = new AbortController();
    const first = queue.run(() => seekTo(video, 1, { signal: controller.signal }));
    const ran: string[] = [];
    const second = queue.run(async () => { ran.push("second"); });
    controller.abort();
    await expect(first).rejects.toBeInstanceOf(SeekAborted);
    await second;
    expect(ran).toEqual(["second"]);
    expect(video.listenerCount()).toBe(0);
  });

  it("fails a seek when its decoder is emptied or aborted, or after the timeout", async () => {
    for (const event of ["emptied", "abort"]) {
      const video = new FakeVideo("manual");
      const pending = seekTo(video, 1);
      video.emit(event);
      await expect(pending).rejects.toBeInstanceOf(SeekAborted);
    }
    await expect(seekTo(new FakeVideo("manual"), 1, { timeoutMs: 10 })).rejects.toBeInstanceOf(SeekTimeout);
    await expect(seekTo(new FakeVideo(), 1, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(SeekAborted);
  });

  it("waits for the picture when an abandoned seek left the element at the requested time", async () => {
    const video = new FakeVideo("manual");
    const controller = new AbortController();
    const abandoned = seekTo(video, 1, { signal: controller.signal });
    controller.abort();
    await expect(abandoned).rejects.toBeInstanceOf(SeekAborted);
    // The element says 1 s but has not decoded it: the next request for 1 s must wait.
    let settled = false;
    const again = seekTo(video, 1).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    video.finish();
    await again;
    expect(video.picture).toBe(1);
  });
});
