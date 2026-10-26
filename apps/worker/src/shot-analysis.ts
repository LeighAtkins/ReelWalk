import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  brightnessRamps,
  closeUpBox,
  closeUpWindows,
  cropWidthFor,
  detectOccluders,
  dominantColours,
  exposureStats,
  flowPeaks,
  flowResidual,
  laplacianVariance,
  motionSegments,
  readMotion,
  rectilinearity,
  reframeTargets,
  resizeGray,
  rgbToGray,
  sharpnessScore,
  shotAnalysisSchema,
  smoothCropPath,
  spectralSaliency,
  steadiness,
  stripMotion,
  strongestCircle,
  blownRegion,
  windowSets,
  flowMagnitude,
  SHOT_ANALYSIS_VERSION,
  type CloseUpReading,
  type DepthSample,
  type Gray,
  type Occluder,
  type Rgb,
  type SceneFacts,
  type ShotAnalysis,
  type ShotSample,
  type StripSample,
} from "@reelwalk/core";
import { killTree, ownChild, OWN_PROCESS_GROUP, type AttemptScope } from "./lifecycle";

/**
 * Shot understanding (ADR 0086): what is in the picture of one video, per
 * moment, measured once on the 720p proxy when it lands, for the cut planner and
 * the director. One streamed decode at 8 fps and 384 px (never the whole file in
 * memory), samples every 250 ms; two small CPU models:
 *
 * - aesthetic: MobileCLIP-S0's image tower (45 MB fp32, ~40 ms a frame on two
 *   threads) scored against CLIP-IQA style prompt pairs whose text embeddings
 *   are precomputed (shot-iqa-prompts.json), so the text tower is never loaded;
 * - depth: Depth Anything V2 small (27 MB int8, ~0.4 s a frame at 266 px) at a
 *   few samples and at each occluder's peak.
 *
 * Both are cached into the worker image at SHOT_MODEL_DIR by
 * scripts/fetch-shot-models.ts; without them the analysis still runs and says
 * so in `models` (aesthetic null, no depth).
 */

const FPS = 8;
const SAMPLE_EVERY = 2; // frames: 250 ms
const LONG_SIDE = 384;
const FLOW_LONG = 96;
const STRIP_LONG = 192;
const AESTHETIC_EVERY_MS = 1000;
const SCENE_EVERY_MS = 1000;

export const AESTHETIC_MODEL = "Xenova/mobileclip_s0";
export const DEPTH_MODEL = "onnx-community/depth-anything-v2-small";
const DEPTH_INPUT = 266; // a multiple of 14, the ViT patch

export function shotModelDir(): string | null {
  return process.env.SHOT_MODEL_DIR || process.env.TRANSCRIBE_MODEL_DIR || null;
}

export function shotAnalysisEnabled(): boolean {
  return process.env.SHOT_ANALYSIS_ENABLED !== "false";
}

type Models = {
  aesthetic: ((rgb: Rgb) => Promise<number>) | null;
  depth: ((rgb: Rgb) => Promise<{ data: Float32Array; width: number; height: number }>) | null;
};
let models: Promise<Models> | null = null;

/** Loads the two models once per process; a model that fails to load is left out (and logged), never fatal. */
export function loadShotModels(log: (line: string) => void = console.log): Promise<Models> {
  models ??= (async () => {
    const dir = shotModelDir();
    if (!dir) return { aesthetic: null, depth: null };
    const transformers = await import("@huggingface/transformers");
    const { env, AutoProcessor, CLIPVisionModelWithProjection, RawImage, pipeline } = transformers;
    env.cacheDir = dir;
    env.allowRemoteModels = process.env.SHOT_ALLOW_DOWNLOAD === "true";
    // The ECS task has 2 vCPUs: one intra-op pool of two threads keeps the models from fighting ffmpeg for more.
    const session_options = { intraOpNumThreads: Number(process.env.SHOT_THREADS ?? 2), interOpNumThreads: 1 };
    const raw = (rgb: Rgb) => new RawImage(rgb.data, rgb.width, rgb.height, 3);
    let aesthetic: Models["aesthetic"] = null;
    try {
      const processor = await AutoProcessor.from_pretrained(AESTHETIC_MODEL);
      const vision = await CLIPVisionModelWithProjection.from_pretrained(AESTHETIC_MODEL, { dtype: "fp32", session_options } as never);
      const prompts = JSON.parse(readFileSync(new URL("./shot-iqa-prompts.json", import.meta.url), "utf8")) as { embeds: number[][] };
      aesthetic = async (rgb) => {
        const { image_embeds } = (await vision(await processor(raw(rgb)))) as { image_embeds: { data: Float32Array } };
        return iqaScore(image_embeds.data, prompts.embeds);
      };
    } catch (error) {
      log(`aesthetic model not loaded: ${error instanceof Error ? error.message : error}`);
    }
    let depth: Models["depth"] = null;
    try {
      const estimator = (await pipeline("depth-estimation", DEPTH_MODEL, { dtype: "q8", session_options } as never)) as unknown as {
        processor: { image_processor: { size: unknown } };
        (image: unknown): Promise<{ predicted_depth: { data: Float32Array; dims: number[] } }>;
      };
      // The model's own 518 px costs 4× the time for a map we keep at 32 × 18.
      estimator.processor.image_processor.size = { height: DEPTH_INPUT, width: DEPTH_INPUT };
      depth = async (rgb) => {
        const { predicted_depth } = await estimator(raw(rgb));
        const [height, width] = predicted_depth.dims.slice(-2);
        return { data: predicted_depth.data, width, height };
      };
    } catch (error) {
      log(`depth model not loaded: ${error instanceof Error ? error.message : error}`);
    }
    return { aesthetic, depth };
  })();
  return models;
}

/** CLIP-IQA (Wang et al., 2023) over prompt pairs [good, bad, good, bad, …]: the mean softmax share of each "good". */
export function iqaScore(image: Float32Array | number[], prompts: number[][]): number {
  const norm = Math.hypot(...image) || 1;
  const sims = prompts.map((p) => p.reduce((sum, v, i) => sum + v * image[i], 0) / norm);
  let total = 0, pairs = 0;
  for (let i = 0; i + 1 < sims.length; i += 2) {
    // A temperature of 50 (CLIP's own is 100) keeps MobileCLIP's tight similarities from saturating at 0 or 1.
    const a = Math.exp(50 * sims[i]), b = Math.exp(50 * sims[i + 1]);
    total += a / (a + b);
    pairs++;
  }
  return pairs ? Math.round((total / pairs) * 1000) / 1000 : 0.5;
}

/** Frame size for the analysis: the long side LONG_SIDE, even numbers, the source's aspect. */
function frameSize(width: number, height: number, long: number): { width: number; height: number } {
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  return width >= height ? { width: long, height: even((long * height) / width) } : { width: even((long * width) / height), height: long };
}

type Decoder = { frames: AsyncGenerator<Rgb>; done: Promise<{ cpuMs: number }> };

/** Streams RGB frames of `input` at `fps` and size; the decoder's own CPU time comes from ffmpeg's -benchmark. */
function decodeFrames(ffmpeg: string, input: string, args: { fps?: number; width: number; height: number; seekMs?: number; frames?: number }, scope?: AttemptScope): Decoder {
  const { width, height } = args;
  const frameBytes = width * height * 3;
  const child = spawn(ffmpeg, [
    "-v", "error", "-benchmark", "-nostdin",
    ...(args.seekMs !== undefined ? ["-ss", (args.seekMs / 1000).toFixed(3)] : []),
    "-i", input,
    "-vf", `${args.fps ? `fps=${args.fps},` : ""}scale=${width}:${height}:flags=area`,
    ...(args.frames ? ["-frames:v", String(args.frames)] : []),
    "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], { detached: OWN_PROCESS_GROUP, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const forget = scope ? ownChild(scope, child, "ffmpeg (shot analysis)") : () => {};
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const done = new Promise<{ cpuMs: number }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      forget();
      if (code !== 0) return reject(new Error(`ffmpeg failed (${code}): ${stderr.trim().slice(-500)}`));
      const bench = /utime=([\d.]+)s\s+stime=([\d.]+)s/.exec(stderr);
      resolve({ cpuMs: bench ? Math.round((Number(bench[1]) + Number(bench[2])) * 1000) : 0 });
    });
  });
  async function* frames(): AsyncGenerator<Rgb> {
    let pending: Buffer = Buffer.alloc(0);
    try {
      for await (const chunk of child.stdout! as AsyncIterable<Buffer>) {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (pending.length >= frameBytes) {
          // A copy: the frame outlives the chunk buffer that ffmpeg's next read reuses.
          yield { data: new Uint8Array(pending.subarray(0, frameBytes)), width, height };
          pending = pending.subarray(frameBytes);
        }
      }
    } finally {
      if (child.exitCode === null) killTree(child, "SIGKILL");
    }
  }
  return { frames: frames(), done };
}

export type ShotSource = { input: string; durationMs: number; width: number; height: number };
export type ShotOptions = { ffmpeg?: string; scope?: AttemptScope; log?: (line: string) => void; depthSamples?: number };

/** Analyses one video file (normally the 720p proxy); `width`/`height`/`durationMs` are the ORIGINAL's, from the asset. */
export async function analyseShot(source: ShotSource, options: ShotOptions = {}): Promise<ShotAnalysis> {
  const ffmpeg = options.ffmpeg ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const log = options.log ?? ((line: string) => console.log(line));
  const started = Date.now(), cpuStart = process.cpuUsage();
  const loaded = await loadShotModels(log);
  const size = frameSize(source.width, source.height, LONG_SIDE);
  const flowSize = frameSize(source.width, source.height, FLOW_LONG);
  const stripSize = frameSize(source.width, source.height, STRIP_LONG);
  const decoder = decodeFrames(ffmpeg, source.input, { fps: FPS, ...size }, options.scope);

  type Pending = Omit<ShotSample, "flow" | "steady"> & { index: number };
  const smalls: { t: number; gray: Gray }[] = [];
  const pending: Pending[] = [];
  const samples: ShotSample[] = [];
  const strips: StripSample[] = [];
  const readings: CloseUpReading[] = [];
  const colourPixels: number[] = [];
  const blowouts: SceneFacts["blowouts"] = [];
  let rectSum = 0, rectN = 0;
  let round: SceneFacts["round"] = null;
  let prevStrip: Gray | null = null;

  const flowFor = (p: Pending) => {
    const around = smalls.filter((s) => Math.abs(s.t - p.t) <= (1000 / FPS) * 1.01);
    const read = readMotion(around);
    if (!read) return { dx: 0, dy: 0, zoom: 0, rotate: 0, magnitude: 0, residual: 0 };
    const first = around[0], last = around[around.length - 1];
    const residual = flowResidual(first.gray, last.gray, read, (last.t - first.t) / 1000);
    const flow = { dx: read.tx, dy: read.ty, zoom: read.zoom, rotate: read.rotate };
    return { dx: round4(flow.dx), dy: round4(flow.dy), zoom: round4(flow.zoom), rotate: round4(flow.rotate), magnitude: round4(flowMagnitude(flow)), residual: round3(residual) };
  };
  const settle = (upTo: number) => {
    while (pending.length && pending[0].index + 1 <= upTo) {
      const p = pending.shift()!;
      const { index: _index, ...rest } = p;
      samples.push({ ...rest, steady: 1, flow: flowFor(p) });
    }
    // Only the frames a pending sample still needs are kept.
    const keepFrom = (pending[0]?.t ?? Infinity) - 1000 / FPS - 1;
    while (smalls.length && smalls[0].t < Math.min(keepFrom, smalls[smalls.length - 1].t - 1000 / FPS - 1)) smalls.shift();
  };

  let index = 0;
  for await (const rgb of decoder.frames) {
    options.scope?.throwIfStopped();
    const t = Math.round((index * 1000) / FPS);
    const gray = rgbToGray(rgb);
    smalls.push({ t, gray: resizeGray(gray, flowSize.width, flowSize.height) });
    const stripGray = resizeGray(gray, stripSize.width, stripSize.height);
    if (index % SAMPLE_EVERY === 0) {
      const exposure = exposureStats(gray);
      const saliency = spectralSaliency(gray);
      const sample: Pending = {
        index, t,
        sharpness: round3(sharpnessScore(laplacianVariance(gray))),
        clipLow: round3(exposure.clipLow), clipHigh: round3(exposure.clipHigh), luma: round3(exposure.luma),
        saliency: { x: round3(saliency.x), y: round3(saliency.y), strength: round3(saliency.strength) },
      };
      if (loaded.aesthetic && t % AESTHETIC_EVERY_MS === 0) sample.aesthetic = await loaded.aesthetic(rgb);
      if (prevStrip) strips.push({ t, strips: stripMotion(prevStrip, stripGray, 12, 16), width: stripSize.width });
      // A virtual close-up around the attention point, measured in the analysed frame.
      const box = closeUpBox(source.width, source.height, saliency.x, saliency.y);
      if (box) {
        const region = { x0: Math.round(box.x * size.width), y0: Math.round(box.y * size.height), x1: Math.round((box.x + box.w) * size.width), y1: Math.round((box.y + box.h) * size.height) };
        readings.push({ t, box, sharpness: round3(sharpnessScore(laplacianVariance(gray, region))), saliency: saliency.strength, steady: 1 });
      }
      if (t % SCENE_EVERY_MS === 0) {
        for (let y = 0; y < 9; y++) for (let x = 0; x < 16; x++) {
          const px = Math.floor(((x + 0.5) * rgb.width) / 16), py = Math.floor(((y + 0.5) * rgb.height) / 9);
          const i = (py * rgb.width + px) * 3;
          colourPixels.push(rgb.data[i], rgb.data[i + 1], rgb.data[i + 2]);
        }
        rectSum += rectilinearity(stripGray); rectN++;
        const circle = strongestCircle(stripGray);
        if (circle && (!round || circle.score > round.score)) round = { t, x: round3(circle.x), y: round3(circle.y), r: round3(circle.r), score: round3(circle.score) };
        const blown = blownRegion(gray);
        if (blown && blown.share >= 0.03 && blowouts.length < 8) {
          blowouts.push({ t, box: { x: round3(blown.x), y: round3(blown.y), w: round3(blown.w), h: round3(blown.h) }, share: round3(blown.share), kind: blown.y === 0 && blown.w >= 0.5 ? "sky" : "window" });
        }
      }
      pending.push(sample);
    }
    prevStrip = stripGray;
    settle(index);
    index++;
  }
  settle(Infinity);
  const decoded = await decoder.done;
  const analysedMs = Math.round((index * 1000) / FPS);

  // Steadiness needs the neighbours either side.
  const steady = steadiness(samples.map((s) => s.flow));
  samples.forEach((s, i) => { s.steady = steady[i]; });
  for (const r of readings) r.steady = samples.find((s) => s.t === r.t)?.steady ?? 1;
  const clean = samples;
  const durationMs = Math.max(analysedMs, 1);

  let occluders: Occluder[] = detectOccluders(strips, { stepMs: (1000 / FPS) * SAMPLE_EVERY });

  // Depth: a few evenly spaced samples, plus each occluder's peak (which it can confirm as near).
  const depth: DepthSample[] = [];
  let depthCpu = 0;
  if (loaded.depth) {
    const evenly = Array.from({ length: options.depthSamples ?? 3 }, (_, i) => Math.round(((i + 1) * durationMs) / ((options.depthSamples ?? 3) + 1) / 250) * 250);
    const times = [...new Set([...evenly, ...occluders.slice(0, 3).map((o) => o.peakMs)])].sort((a, b) => a - b).slice(0, 8);
    for (const t of times) {
      options.scope?.throwIfStopped();
      const one = decodeFrames(ffmpeg, source.input, { ...size, seekMs: t, frames: 1 }, options.scope);
      let frame: Rgb | null = null;
      for await (const rgb of one.frames) frame = rgb;
      depthCpu += (await one.done).cpuMs;
      if (!frame) continue;
      depth.push(depthSample(t, await loaded.depth(frame)));
    }
    occluders = occluders.map((o) => confirmNear(o, depth));
  }

  const aspect = source.width / source.height;
  const cropWidth = cropWidthFor(aspect);
  const closeUps = closeUpWindows(readings, source.width);
  // A source wider than the reel gets a crop path; any source with enough pixels lists its close-ups.
  const reframe = cropWidth < 1 || closeUps.length
    ? {
        aspect: round4(aspect),
        cropWidth: round4(cropWidth),
        path: cropWidth < 1 ? smoothCropPath(reframeTargets(clean), { cropWidth }).map((key) => ({ t: key.t, x: key.x, y: 0.5 })) : [],
        closeUps,
      }
    : null;

  const cpu = process.cpuUsage(cpuStart);
  const analysis: ShotAnalysis = {
    version: SHOT_ANALYSIS_VERSION,
    durationMs: source.durationMs || durationMs,
    width: source.width,
    height: source.height,
    sampleMs: (1000 / FPS) * SAMPLE_EVERY,
    aestheticEveryMs: AESTHETIC_EVERY_MS,
    samples: clean,
    windows: windowSets(clean, durationMs),
    motion: motionSegments(clean, 500, durationMs),
    flowPeaks: flowPeaks(clean),
    depth,
    occluders,
    reframe,
    scene: {
      palette: dominantColours(colourPixels, 5),
      round: round && (round as { score: number }).score >= 0.35 ? round : null,
      rectilinear: round3(rectN ? rectSum / rectN : 0),
      brightnessRamps: brightnessRamps(clean),
      blowouts,
    },
    models: { aesthetic: loaded.aesthetic ? `${AESTHETIC_MODEL} (CLIP-IQA prompt pairs)` : null, depth: loaded.depth ? `${DEPTH_MODEL} q8 @${DEPTH_INPUT}` : null, saliency: "spectral-residual 64x64" },
    cost: { cpuMs: Math.round((cpu.user + cpu.system) / 1000) + decoded.cpuMs + depthCpu, wallMs: Date.now() - started, analysedMs },
    createdAt: new Date().toISOString(),
  };
  return shotAnalysisSchema.parse(analysis);
}

/** A depth map as the contract's sample: a 32 × 18 (or 18 × 32) nearness grid, the foreground share, the near blob and the spread. */
export function depthSample(t: number, map: { data: Float32Array; width: number; height: number }): DepthSample {
  const cols = map.width >= map.height ? 32 : 18, rows = map.width >= map.height ? 18 : 32;
  const cells = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const x0 = Math.floor((x * map.width) / cols), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * map.width) / cols));
    const y0 = Math.floor((y * map.height) / rows), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * map.height) / rows));
    let sum = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += map.data[yy * map.width + xx];
    cells[y * cols + x] = sum / ((y1 - y0) * (x1 - x0));
  }
  // Depth Anything gives relative inverse depth: larger is nearer. Normalise on the 2nd..98th percentile.
  const sorted = Float32Array.from(cells).sort();
  const lo = sorted[Math.floor(sorted.length * 0.02)], hi = sorted[Math.floor(sorted.length * 0.98)];
  const range = Math.max(1e-6, hi - lo);
  const bytes = new Uint8Array(cells.length);
  let foreground = 0;
  for (let i = 0; i < cells.length; i++) {
    const v = Math.min(1, Math.max(0, (cells[i] - lo) / range));
    bytes[i] = Math.round(v * 255);
    if (v > 0.66) foreground++;
  }
  // The nearest compact blob: the box of the largest 4-connected region over 0.66, if it is under half the frame.
  const seen = new Uint8Array(cells.length);
  let best: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (seen[i] || bytes[i] <= 168) continue;
    const region: number[] = [], stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      region.push(j);
      const x = j % cols, y = Math.floor(j / cols);
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const k = ny * cols + nx;
        if (!seen[k] && bytes[k] > 168) { seen[k] = 1; stack.push(k); }
      }
    }
    if (region.length > best.length) best = region;
  }
  let near: DepthSample["near"] = null;
  if (best.length >= 4 && best.length < cells.length * 0.5) {
    const xs = best.map((j) => j % cols), ys = best.map((j) => Math.floor(j / cols));
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    near = { x: round3(minX / cols), y: round3(minY / rows), w: round3((maxX - minX + 1) / cols), h: round3((maxY - minY + 1) / rows) };
  }
  // Inverse depth: far things are near 0, so (near − far) / near is about 1 for a deep view or corridor and 0 for a flat wall.
  const p95 = sorted[Math.floor(sorted.length * 0.95)], p5 = sorted[Math.floor(sorted.length * 0.05)];
  const spread = Math.min(1, (p95 - p5) / Math.max(1e-6, Math.abs(p95)));
  return { t, cols, rows, grid: Buffer.from(bytes).toString("base64"), foreground: round3(foreground / cells.length), near, spread: round3(Math.max(0, spread)) };
}

/** An occluder whose band holds a near blob in a depth sample taken at its peak is near, and surer. */
function confirmNear(occluder: Occluder, depth: readonly DepthSample[]): Occluder {
  const at = depth.find((d) => Math.abs(d.t - occluder.peakMs) <= 250);
  if (!at?.near) return occluder;
  const band = occluder.direction === "right" ? [Math.min(occluder.edgeFrom, occluder.edgeTo) - occluder.coverage, Math.max(occluder.edgeFrom, occluder.edgeTo)] : [Math.min(occluder.edgeFrom, occluder.edgeTo), Math.max(occluder.edgeFrom, occluder.edgeTo) + occluder.coverage];
  const overlaps = at.near.x < band[1] && at.near.x + at.near.w > band[0];
  return overlaps ? { ...occluder, near: true, score: round3(Math.min(1, occluder.score + 0.15)) } : occluder;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const round4 = (value: number) => Math.round(value * 10000) / 10000;
