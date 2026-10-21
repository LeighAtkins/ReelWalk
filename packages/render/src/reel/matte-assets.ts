/**
 * The exact bytes the mattes run on (ADR 0051). Both models were read from
 * MediaPipe's `latest` channel, which Google can repoint at any time and
 * silently change every matte. They are now named by version *and* checked
 * by SHA-256 when they load, in the editor and in the render alike: a byte
 * that differs fails the load (and so the export) instead of producing a
 * different matte. The WASM runtime is the npm package's own files at the
 * exact version in package.json, the SIMD build named explicitly rather than
 * picked by feature detection.
 *
 * The editor reads everything from its own origin (its CSP allows scripts
 * from 'self' only; `apps/web/next.config.ts` rewrites these paths to the
 * pinned upstream URLs). The render's headless Chrome has no CSP and reads
 * the same pinned URLs directly. Bump a hash or a version here and
 * MATTE_VERSION changes with it.
 */

export const TASKS_VISION_VERSION = "1.1.1";

export const MATTE_WASM = {
  loader: { file: "vision_wasm_internal.js", sha256: "6522286aa32dd93eff17c3da002b0649516f87abfec7a80b5bfe5c9625caa5f8" },
  binary: { file: "vision_wasm_internal.wasm", sha256: "0e101a010e262ef8e78f22e3c95b60a9705fd06962753c9acd6356d9fb56b7bd" },
} as const;

export const MATTE_MODELS = {
  /** People in the shot (ADR 0039). */
  selfie: {
    file: "selfie_segmenter.tflite",
    bytes: 249_537,
    sha256: "191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b",
    upstream: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite",
  },
  /** The object under a tap (ADR 0044). */
  touch: {
    file: "magic_touch.tflite",
    bytes: 6_227_884,
    sha256: "e24338a717c1b7ad8d159666677ef400babb7f33b8ad60c4d96db4ecf694cd25",
    upstream: "https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite",
  },
} as const;

export type MatteModel = keyof typeof MATTE_MODELS;

const CDN_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const SAME_ORIGIN_WASM = `/mediapipe/${TASKS_VISION_VERSION}/wasm`;

/** The editor's same-origin path for a model: its hash prefix in the path, so a cached old model is never served for a new one. */
export function sameOriginModelPath(model: MatteModel): string {
  const { sha256, file } = MATTE_MODELS[model];
  return `/mediapipe/models/${sha256.slice(0, 16)}/${file}`;
}

/** Where the runtime and a model load from, in the editor (`isRendering` false) or a render. */
export function matteAssetUrls(model: MatteModel, isRendering: boolean): { wasmLoaderPath: string; wasmBinaryPath: string; model: string } {
  const base = isRendering ? CDN_WASM : SAME_ORIGIN_WASM;
  return {
    wasmLoaderPath: `${base}/${MATTE_WASM.loader.file}`,
    wasmBinaryPath: `${base}/${MATTE_WASM.binary.file}`,
    model: isRendering ? MATTE_MODELS[model].upstream : sameOriginModelPath(model),
  };
}

export function toHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Throws unless `bytes` are the pinned model's. */
export async function verifyModel(model: MatteModel, bytes: Uint8Array): Promise<void> {
  const expected = MATTE_MODELS[model].sha256;
  const actual = toHex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  if (actual !== expected) throw new Error(`the ${MATTE_MODELS[model].file} model is not the pinned one (sha256 ${actual.slice(0, 16)}…, expected ${expected.slice(0, 16)}…)`);
}

export type VisionModule = typeof import("@mediapipe/tasks-vision");
export type PinnedFileset = { wasmLoaderPath: string; wasmBinaryPath: string };

/**
 * Opens a MediaPipe task on the pinned runtime and the verified model bytes.
 * `make` builds the task from them (ImageSegmenter, InteractiveSegmenter…).
 */
export async function openVisionTask<T>(model: MatteModel, isRendering: boolean, make: (vision: VisionModule, fileset: PinnedFileset, modelAssetBuffer: Uint8Array) => Promise<T>): Promise<T> {
  const { wasmLoaderPath, wasmBinaryPath } = matteAssetUrls(model, isRendering);
  const [vision, bytes] = await Promise.all([import("@mediapipe/tasks-vision"), loadPinnedModel(model, isRendering)]);
  return make(vision, { wasmLoaderPath, wasmBinaryPath }, bytes);
}

/** Fetches a model's bytes and checks them against the pin; the bytes go to MediaPipe as `modelAssetBuffer`. */
export async function loadPinnedModel(model: MatteModel, isRendering: boolean, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  const url = matteAssetUrls(model, isRendering).model;
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`the ${MATTE_MODELS[model].file} model did not download (HTTP ${response.status} from ${url})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await verifyModel(model, bytes);
  return bytes;
}
