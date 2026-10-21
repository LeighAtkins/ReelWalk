import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPinnedModel, MATTE_MODELS, MATTE_WASM, matteAssetUrls, sameOriginModelPath, TASKS_VISION_VERSION, verifyModel, type MatteModel } from "../src/reel/matte-assets";

const here = path.dirname(fileURLToPath(import.meta.url));
const renderRoot = path.join(here, "..");
const nextConfig = readFileSync(path.join(renderRoot, "../../apps/web/next.config.ts"), "utf8");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sources(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const models = Object.keys(MATTE_MODELS) as MatteModel[];

describe("pinned matte assets (ADR 0051)", () => {
  it("never loads a `latest` URL, in the render sources or the editor's rewrites", () => {
    const files = [...sources(path.join(renderRoot, "src")), path.join(renderRoot, "../../apps/web/next.config.ts")];
    for (const file of files) {
      const urls = readFileSync(file, "utf8").match(/https?:\/\/[^\s"'`)]+/g) ?? [];
      for (const url of urls) expect(url, `${path.basename(file)}: ${url}`).not.toMatch(/latest/i);
    }
    for (const model of models) for (const rendering of [true, false]) {
      expect(Object.values(matteAssetUrls(model, rendering)).join(" ")).not.toMatch(/latest/i);
    }
  });

  it("serves the editor exactly the URLs the render reads, by rewrite", () => {
    for (const model of models) {
      const rewrite = `{ source: "${sameOriginModelPath(model)}", destination: "${MATTE_MODELS[model].upstream}" }`;
      expect(nextConfig).toContain(rewrite);
      expect(sameOriginModelPath(model)).toContain(MATTE_MODELS[model].sha256.slice(0, 16));
    }
    const wasm = `{ source: "/mediapipe/${TASKS_VISION_VERSION}/wasm/:path*", destination: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm/:path*" }`;
    expect(nextConfig).toContain(wasm);
    const editor = matteAssetUrls("selfie", false), render = matteAssetUrls("selfie", true);
    expect(editor.wasmBinaryPath).toBe(`/mediapipe/${TASKS_VISION_VERSION}/wasm/${MATTE_WASM.binary.file}`);
    expect(render.wasmBinaryPath).toBe(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm/${MATTE_WASM.binary.file}`);
  });

  it("pins the runtime to the installed package, file by file", () => {
    const pkg = JSON.parse(readFileSync(path.join(renderRoot, "package.json"), "utf8"));
    expect(pkg.dependencies["@mediapipe/tasks-vision"]).toBe(TASKS_VISION_VERSION);
    const installed = path.join(renderRoot, "node_modules", "@mediapipe", "tasks-vision");
    expect(JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8")).version).toBe(TASKS_VISION_VERSION);
    for (const part of Object.values(MATTE_WASM)) {
      const digest = createHash("sha256").update(readFileSync(path.join(installed, "wasm", part.file))).digest("hex");
      expect(digest, part.file).toBe(part.sha256);
    }
  });

  it("rejects a model whose bytes are not the pinned ones, and a failed download", async () => {
    await expect(verifyModel("selfie", new Uint8Array([1, 2, 3]))).rejects.toThrow(/not the pinned one/);
    const ok = async () => new Response(new Uint8Array([1, 2, 3]));
    await expect(loadPinnedModel("touch", true, ok as unknown as typeof fetch)).rejects.toThrow(/magic_touch.tflite model is not the pinned one/);
    const missing = async () => new Response("no", { status: 404 });
    await expect(loadPinnedModel("selfie", false, missing as unknown as typeof fetch)).rejects.toThrow(/HTTP 404 from \/mediapipe\/models\//);
  });
});
