// Local proof harness for ADR 0089 round 3 (head-following, moving take) (not committed): the v2 production batch (cut, camera, lockups;
// not the music) run through the real applyCommand on this branch, rendered with the real renderer.
//   tsx scripts/_interlock-local.mts <plan|render|stills> <outDir> <apply.json> [frames]
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { applyCommand, describeLockups, parseTimeline, type Command, type Timeline } from "@reelwalk/core";
import { renderReel, renderReelStills } from "../src/render-reel";
import { serve } from "./smoke-fixture";

const V4 = "C:/Users/Memory is RAM/Documents/projects/ReelWalk-hybrid/output/recipes/one-question-v4";
const T1 = "ai-cmvp7k7xa000301advm8862wp", T2 = "ai-cmvp86zcm000201adzmq6mjp5", WALK = "ai-cmvpbo9rt000201adi0mmwz9t";
const FILES: Record<string, string> = { [T1]: `${V4}/takes/t1.mp4`, [T2]: `${V4}/takes/t2.mp4`, [WALK]: `${V4}/takes/walk.mp4` };
const IDS = ["ec10b467-a6e1-4882-9543-f9227cd48b09", "87437707-3244-4f1a-af3e-501f01c305e7", "walk-moving-take", "442e600a-d2a8-4008-abf7-286b3654e1f1"];
const ASSETS = [T1, T1, WALK, T2];
const [mode, outDir, applyFile, frameList] = process.argv.slice(2);
await mkdir(outDir, { recursive: true });
const batch = JSON.parse(await readFile(applyFile, "utf8")) as { commands: Command[] };
let timeline: Timeline = parseTimeline({ version: 1, texts: [], music: null,
  clips: IDS.map((id, i) => ({ id, assetId: ASSETS[i], kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 8000 })) });
for (const command of batch.commands.filter((c) => c.type !== "setMusic")) {
  const result = applyCommand(timeline, command, { generation: 0 });
  if (result.rejected) throw new Error(`${command.type}: ${result.rejected}`);
  timeline = result.timeline;
}
await writeFile(path.join(outDir, "timeline.json"), JSON.stringify(timeline, null, 1));
await writeFile(path.join(outDir, "lockups.json"), JSON.stringify(describeLockups(timeline), null, 1));
console.log(JSON.stringify(describeLockups(timeline).map((l) => [l.layout, l.phrase, l.startMs, l.endMs, l.keywordAt]), null, 0));
for (const t of timeline.texts) console.log(t.id.slice(0, 18), t.text, t.startMs, t.endMs, t.x, t.y, t.path ? `path ${t.path.length} dx ${Math.min(...t.path.map((p) => p.x)).toFixed(3)}..${Math.max(...t.path.map((p) => p.x)).toFixed(3)} dy ${Math.min(...t.path.map((p) => p.y)).toFixed(3)}..${Math.max(...t.path.map((p) => p.y)).toFixed(3)}` : "static");
if (mode === "plan") process.exit(0);
const media = path.join(outDir, "media");
await mkdir(media, { recursive: true });
for (const [id, file] of Object.entries(FILES)) await copyFile(file, path.join(media, `${id}.mp4`));
const server = await serve(media);
const assets = Object.fromEntries(Object.keys(FILES).map((id) => [id, { src: `${server.url}/${id}.mp4`, kind: "VIDEO" as const }]));
try {
  if (mode === "render") {
    const out = await renderReel({ timeline, assets, output: path.join(outDir, "reel-720.mp4"), width: 720, concurrency: 2 }, (f) => process.stdout.write(`\r${Math.round(f * 100)}%`));
    console.log(`\n${out}`);
  } else {
    const frames = frameList.split(",").map(Number);
    const out = await renderReelStills({ timeline, assets, frames, dir: outDir, width: 540, timeoutMs: 180_000 });
    console.log([...out.values()].join("\n"));
  }
} finally { server.close(); }
process.exit(0);
