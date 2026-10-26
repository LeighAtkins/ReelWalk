// Runs the shot analysis (ADR 0086) on local video files, outside the queue: for proving it on real footage and
// measuring its cost. Usage: tsx scripts/analyse-shots.ts <manifest.json> <out-dir>
// The manifest is [{ "assetId", "fileName", "input", "durationMs", "width", "height" }] (sizes of the ORIGINAL upload).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { analyseShot, loadShotModels } from "../src/shot-analysis";

const [manifestPath, outDir] = process.argv.slice(2);
if (!manifestPath || !outDir) throw new Error("Usage: tsx scripts/analyse-shots.ts <manifest.json> <out-dir>");
type Entry = { assetId: string; fileName: string; input: string; durationMs: number; width: number; height: number };
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Entry[];
mkdirSync(outDir, { recursive: true });
const loadStart = Date.now(), loadCpu = process.cpuUsage();
await loadShotModels();
const load = process.cpuUsage(loadCpu);
console.log(`models loaded in ${Date.now() - loadStart} ms (cpu ${Math.round((load.user + load.system) / 1000)} ms), rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`);
const rows: unknown[] = [];
const clips: Record<string, unknown> = {};
for (const entry of manifest) {
  const analysis = await analyseShot(entry, { log: (line) => console.log(`[${entry.fileName}] ${line}`) });
  writeFileSync(path.join(outDir, `${entry.fileName.replace(/\.\w+$/, "")}.json`), JSON.stringify(analysis));
  clips[entry.assetId] = { fileName: entry.fileName, analysis };
  const cost = analysis.cost!;
  const row = { file: entry.fileName, seconds: cost.analysedMs / 1000, cpuMs: cost.cpuMs, wallMs: cost.wallMs, cpuPerMin: Math.round(cost.cpuMs / (cost.analysedMs / 60000)), rssMB: Math.round(process.memoryUsage().rss / 1e6), samples: analysis.samples.length, depth: analysis.depth.length, occluders: analysis.occluders.length, closeUps: analysis.reframe?.closeUps.length ?? 0 };
  rows.push(row);
  console.log(JSON.stringify(row));
}
const peakMB = Math.round(process.resourceUsage().maxRSS / 1024);
writeFileSync(path.join(outDir, "clips.json"), JSON.stringify({ clips }, null, 1));
writeFileSync(path.join(outDir, "cost.json"), JSON.stringify({ rows, peakRssMB: peakMB, totalWallMs: Date.now() - loadStart }, null, 1));
console.log(`peak rss ${peakMB} MB`);
