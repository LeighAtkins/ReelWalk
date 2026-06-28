import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { z } from "zod";

const argsSchema = z.object({
  project: z.string().min(1),
  output: z.string().min(1),
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

export async function renderTimelineProject(params: z.infer<typeof argsSchema>): Promise<string> {
  const currentFile = fileURLToPath(import.meta.url);
  const entryPoint = path.join(path.dirname(currentFile), "index.ts");

  // Read project JSON
  const projectJson = await readFile(params.project, "utf-8");
  const project = JSON.parse(projectJson);

  console.log(`[render-timeline] bundling Remotion entry point...`);
  const serveUrl = await bundle({
    entryPoint,
    webpackOverride: (config) => config,
  });

  console.log(`[render-timeline] selecting composition TimelineProject...`);
  const composition = await selectComposition({
    serveUrl,
    id: "TimelineProject",
    inputProps: { project },
  });

  const outputPath = path.resolve(params.output);
  console.log(`[render-timeline] rendering to ${outputPath}...`);
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    inputProps: { project },
    outputLocation: outputPath,
  });

  console.log(`[render-timeline] done!`);
  return outputPath;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const params = parseArgs(process.argv.slice(2));
  renderTimelineProject(params).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
