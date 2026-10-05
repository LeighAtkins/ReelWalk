import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { z } from "zod";
import { STUB_REEL } from "./constants";

const argsSchema = z.object({
  input: z.string().min(1),
  output: z.string().min(1),
  caption: z.string().default(STUB_REEL.caption),
  brand: z.string().default(STUB_REEL.brand),
});

function parseArgs(argv: string[]) {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (key && value) raw[key] = value;
  }
  return argsSchema.parse(raw);
}

export type RenderProgress = (fraction: number) => void;

export async function renderStubReel(
  input: z.input<typeof argsSchema>,
  onProgress?: RenderProgress,
): Promise<string> {
  const params = argsSchema.parse(input);
  const currentFile = fileURLToPath(import.meta.url);
  const entryPoint = path.join(path.dirname(currentFile), "index.ts");
  const resolvedInput = path.resolve(params.input);
  const serveUrl = await bundle({
    entryPoint,
    publicDir: path.dirname(resolvedInput),
    webpackOverride: (config) => config,
  });
  const inputProps = {
    inputVideo: path.basename(resolvedInput),
    caption: params.caption,
    brand: params.brand,
  };
  const composition = await selectComposition({
    serveUrl,
    id: STUB_REEL.id,
    inputProps,
  });

  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    inputProps,
    outputLocation: path.resolve(params.output),
    onProgress: ({ progress }) => onProgress?.(progress),
  });

  return path.resolve(params.output);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const params = parseArgs(process.argv.slice(2));
  renderStubReel(params).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
