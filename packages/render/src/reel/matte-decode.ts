/**
 * Stepping a matte's decode (ADR 0051). Kept free of React and Remotion so the
 * seek rules can be tested with a fake element.
 *
 * - `seekTo` resolves only once the element holds the picture at the
 *   requested source time (see SAME_TIME_S for what "at" means). It used to
 *   accept anything within half a composition frame, but at 0.25× speed
 *   adjacent source frames are 8 ms apart, so the previous picture was
 *   labelled as the current one and the alpha depended on render history.
 * - A request past the end of the file is clamped to the element's duration,
 *   as the browser clamps currentTime: asset durations are stored rounded and
 *   a clip's last frame can ask for a time just past the last picture.
 * - Every seek is bounded (a timeout) and abortable (an AbortSignal), and an
 *   element being emptied or aborted fails it, so a superseded frame or a
 *   replaced decoder can never leave a promise pending forever.
 * - `SerialQueue` runs a decoder's matte jobs one at a time; a job that fails
 *   or is aborted does not block the next.
 */
import type { PersonFrame, PersonMatteRule } from "./matte-core";

/** What a seek needs from a video element. */
export type Decoder = {
  currentTime: number;
  /** Seconds; NaN until the metadata has loaded. */
  readonly duration: number;
  readonly readyState: number;
  /** True while a seek is in flight (an abandoned one included): the picture is not yet the one at currentTime. */
  readonly seeking: boolean;
  readonly error: { code: number } | null;
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: () => void): void;
};

export const SEEK_TIMEOUT_MS = 15_000;

/**
 * How close the element's reported time must be to the requested one for its
 * picture to count as the one asked for. Browsers do not read back the value
 * set: Chrome keeps media time in whole microseconds and truncates (61/30 s
 * reads back as 2.033332 s), and WebKit may use a coarser timescale. 3 ms
 * covers a timescale as coarse as 1/600 s with room to spare, and stays under
 * half the closest two requests can be (8.3 ms: neighbouring frames of a
 * 0.25× clip at 30 fps), so it can never take a neighbour for the frame.
 */
export const SAME_TIME_S = 3e-3;
const sameTime = (a: number, b: number) => Math.abs(a - b) < SAME_TIME_S;

/** The time the element will actually land on: the browser clamps a seek to the duration. */
export function seekTarget(element: Pick<Decoder, "duration">, seconds: number): number {
  return Number.isFinite(element.duration) && element.duration > 0 ? Math.min(seconds, element.duration) : seconds;
}

/** The exact time each decoder last confirmed a decoded picture for. */
const decoded = new WeakMap<object, number>();

export class SeekAborted extends Error {
  constructor(reason: string) { super(`seek ${reason}`); this.name = "SeekAborted"; }
}

export class SeekTimeout extends Error {
  constructor(message: string) { super(message); this.name = "SeekTimeout"; }
}

/** Thrown inside a matte job whose frame is no longer wanted; never reported. */
export const CANCELLED = new Error("matte frame superseded");

/**
 * What a view does with a matte job's error: a superseded job is ignored; a seek
 * that timed out in the editor is retried on the next frame (a console warning,
 * not a latched failure); anything else, and any error in an export, fails (an
 * export is cancelled, the editor shows a warning).
 */
export function failureAction(error: unknown, isRendering: boolean): "ignore" | "retry" | "fail" {
  if (error === CANCELLED || error instanceof SeekAborted) return "ignore";
  if (error instanceof SeekTimeout && !isRendering) return "retry";
  return "fail";
}

/** Steps `element` to `seconds` (clamped to its duration) and resolves once it holds that picture (readyState ≥ 2). */
export function seekTo(element: Decoder, seconds: number, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  const { signal, timeoutMs = SEEK_TIMEOUT_MS } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new SeekAborted("aborted")); return; }
    if (decoded.get(element) === seconds && element.readyState >= 2 && !element.seeking) { resolve(); return; }
    const events: [string, () => void][] = [];
    let seekedSeen = 0;
    // Re-read each time: the duration is NaN until the metadata loads, and the browser clamps once it has.
    const landed = () => sameTime(element.currentTime, seekTarget(element, seconds));
    const cleanup = () => {
      clearTimeout(timer);
      for (const [type, listener] of events) element.removeEventListener(type, listener);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const done = () => { cleanup(); decoded.set(element, seconds); resolve(); };
    const on = (type: string, listener: () => void) => { events.push([type, listener]); element.addEventListener(type, listener); };
    const onAbort = () => fail(new SeekAborted("aborted"));
    // Declared after `cleanup`, which only runs once a listener or this timer fires.
    const timer = setTimeout(() => fail(new SeekTimeout(`seek to ${seconds} s timed out after ${timeoutMs} ms (at ${element.currentTime} s of ${element.duration} s, seeking ${element.seeking}, readyState ${element.readyState}, seeked events ${seekedSeen})`)), timeoutMs);
    signal?.addEventListener("abort", onAbort);
    on("error", () => fail(new Error(element.error ? `video error ${element.error.code}` : "video error")));
    on("emptied", () => fail(new SeekAborted("abandoned: the decoder was emptied")));
    on("abort", () => fail(new SeekAborted("abandoned: the decoder's load was aborted")));
    decoded.delete(element);
    if (landed()) {
      // Already at this time (a fresh decode at 0, or an abandoned seek still landing): setting
      // currentTime again may fire no `seeked`, so wait for the picture instead.
      if (element.readyState >= 2 && !element.seeking) { done(); return; }
      on("loadeddata", () => { if (!element.seeking) done(); });
      on("seeked", done);
      return;
    }
    // A late `seeked` from an earlier, abandoned seek must not count: check the time it landed on.
    on("seeked", () => { seekedSeen++; if (landed()) done(); });
    element.currentTime = seekTarget(element, seconds);
  });
}

/** Runs jobs one after another; a job that throws (or is aborted) does not stop the next. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  run(job: () => Promise<void>): Promise<void> {
    const next = this.tail.then(job);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** A matte cache key for the picture at source time `seconds`: exact to the microsecond, so neighbouring frames at any speed differ. */
export function pictureKey(scope: string, seconds: number): string {
  return `${scope}|${seconds.toFixed(6)}`;
}

/**
 * Frame `frame`'s person alpha through the seek adapter: the rule asks for pictures
 * n − 1 and n (when not held), each read by seeking to its exact source time and
 * capturing; the decoder is left on frame n for the composite.
 */
export async function personMatteFrame(input: {
  rule: PersonMatteRule; frame: number; scope: string; seconds(n: number): number;
  seek(seconds: number): Promise<void>; capture(): PersonFrame;
}): Promise<Uint8ClampedArray | null> {
  const { rule, frame, scope, seconds, seek, capture } = input;
  const frames = new Map<string, number>([[pictureKey(scope, seconds(frame)), frame]]);
  if (frame > 0) frames.set(pictureKey(scope, seconds(frame - 1)), frame - 1);
  const alpha = await rule.matte(pictureKey(scope, seconds(frame)), frame > 0 ? pictureKey(scope, seconds(frame - 1)) : null, async (key) => {
    await seek(seconds(frames.get(key)!));
    return capture();
  });
  if (alpha) await seek(seconds(frame));
  return alpha;
}
