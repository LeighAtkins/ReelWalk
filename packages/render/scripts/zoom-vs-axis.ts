/**
 * The zoom blur against the axis blur on a forward move (ADR 0074): the
 * showcase defect (ADR 0073's first reel, cut 4: a dolly into the dining room,
 * blurred sideways because the footage read as "still") reproduced and fixed
 * with the real renderer.
 *
 *   FFMPEG=<ffmpeg> pnpm --filter @reelwalk/render exec tsx scripts/zoom-vs-axis.ts \
 *     --out contact-sheet.png [--a dolly.mp4 --b pan.mp4] [--export] [--keep dir]
 *
 * `--a` is a shot that pushes in (used whole, at most 1.7 s), `--b` a shot that
 * pans (used whole, at most 1.0 s); without them both are synthesised from
 * ffmpeg's test pattern (a zoom and a pan of it). The script reads the footage
 * the way the editor does (`readMotion` on three small grey frames across the
 * last half second of a and the first of b), stores what it found on the
 * cut as `rampFootage`, and renders the frames across the cut twice: BEFORE,
 * with no reading ("auto" falls back to a horizontal blur, what the planner did
 * before this change) and AFTER, with it ("auto" picks the zoom blur on the
 * push). Top row before, bottom row after. With `--export` it also times the
 * export of the reel with the cut plain, with the axis blur and with the zoom
 * blur.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { edgeSampleTimes, framePlan, readMotion, sideReadOf, type Gray, type MotionFrame, type RampFootage, type Timeline } from "@reelwalk/core";
import { renderReel, renderReelStills } from "../src/render-reel";
import type { ReelAsset } from "../src/reel/types";
import { ffmpegBin } from "./acceptance/ffmpeg";
import { serve } from "./smoke-fixture";
import { ZOOM_ASSET_DURATIONS, zoomCutPlan, zoomCutTimeline } from "./speed-ramp-fixture";

const run = promisify(execFile);
const GRAY_W = 96, GRAY_H = 170;

async function grayAt(file: string, ms: number): Promise<Gray> {
  const { stdout } = await run(ffmpegBin(), ["-v", "error", "-ss", (ms / 1000).toFixed(3), "-i", file, "-frames:v", "1", "-vf", `scale=${GRAY_W}:${GRAY_H}:flags=area,format=gray`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  if (stdout.length !== GRAY_W * GRAY_H) throw new Error(`could not read a frame of ${file} at ${ms} ms`);
  return { data: Float32Array.from(stdout), width: GRAY_W, height: GRAY_H };
}

async function readEdge(file: string, side: "head" | "tail", lengthMs: number) {
  const times = edgeSampleTimes(side, 0, lengthMs);
  const frames: MotionFrame[] = [];
  for (const t of times) frames.push({ t, gray: await grayAt(file, t) });
  return readMotion(frames);
}

async function synthesise(dir: string) {
  const common = ["-v", "error", "-y", "-f", "lavfi", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-g", "15"];
  // A push in (a zoom of the pattern about a point a little left of centre) and a sideways pan of it.
  await run(ffmpegBin(), [...common, "-i", "testsrc2=size=1080x1920:rate=30", "-vf", "zoompan=z='min(1+0.004*on,1.9)':x='iw*0.4-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30", "-t", "1.7", path.join(dir, "a.mp4")]);
  await run(ffmpegBin(), [...common, "-i", "testsrc2=size=1620x2880:rate=30", "-vf", "crop=1080:1920:x='t*320':y=480", "-t", "1.0", path.join(dir, "b.mp4")]);
}

async function label(input: string, output: string, text: string) {
  // Burned-in labels need a font ffmpeg can find; without one the row is left plain.
  const font = process.platform === "win32" ? "C\\:/Windows/Fonts/arial.ttf" : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
  try {
    await run(ffmpegBin(), ["-v", "error", "-y", "-i", input, "-vf", `drawtext=fontfile='${font}':text='${text}':x=10:y=8:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6`, output]);
  } catch {
    await copyFile(input, output);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const out = path.resolve(arg("--out") ?? "zoom-vs-axis.png");
  const keep = arg("--keep");
  const dir = keep ? path.resolve(keep) : await mkdtemp(path.join(os.tmpdir(), "reelwalk-zoom-"));
  await mkdir(dir, { recursive: true });
  const media = path.join(dir, "media");
  await mkdir(media, { recursive: true });
  const server = await serve(media);
  try {
    if (arg("--a") && arg("--b")) {
      await copyFile(path.resolve(arg("--a")!), path.join(media, "a.mp4"));
      await copyFile(path.resolve(arg("--b")!), path.join(media, "b.mp4"));
    } else await synthesise(media);

    const outgoing = await readEdge(path.join(media, "a.mp4"), "tail", ZOOM_ASSET_DURATIONS.a);
    const incoming = await readEdge(path.join(media, "b.mp4"), "head", ZOOM_ASSET_DURATIONS.b);
    const round = (value: number) => Math.round(value * 1000) / 1000;
    for (const [name, read] of [["outgoing tail", outgoing], ["incoming head", incoming]] as const) {
      console.log(`zoom-vs-axis: ${name}: ${read ? `${read.kind} (tx ${round(read.tx)}, ty ${round(read.ty)} fw/s, zoom ${round(read.zoom)}/s, roll ${round(read.rotate)} rad/s${read.focus ? `, focus ${round(read.focus.x)},${round(read.focus.y)}` : ""}, confidence ${read.confidence})` : "unreadable"}`);
    }
    const footage: RampFootage = { after: "c1", ...(outgoing ? { out: sideReadOf(outgoing) } : {}), ...(incoming ? { in: sideReadOf(incoming) } : {}) };

    const assets: Record<string, ReelAsset> = Object.fromEntries(Object.keys(ZOOM_ASSET_DURATIONS).map((id) => [id, { src: `${server.url}/${id}.mp4`, kind: "VIDEO" as const, durationMs: ZOOM_ASSET_DURATIONS[id] }]));
    const before = zoomCutTimeline(undefined), after = zoomCutTimeline(footage);
    for (const [name, timeline] of [["before", before], ["after", after]] as const) console.log(`zoom-vs-axis: ${name}: ${zoomCutPlan(timeline).cuts.map((cut) => cut.note).join(" ")}`);

    const cut = framePlan(before, 30).clips[0].durationInFrames;
    const frames = Array.from({ length: 12 }, (_, i) => cut - 6 + i);
    const rows: string[] = [];
    for (const [name, timeline, text] of [["before", before, "BEFORE: horizontal blur (footage read as still)"], ["after", after, "AFTER: zoom blur on the push, sideways on the pan"]] as const) {
      const stills = path.join(dir, `stills-${name}`);
      await mkdir(stills, { recursive: true });
      await renderReelStills({ timeline, assets, frames, dir: stills, width: 270, timeoutMs: 90_000 });
      const list = path.join(dir, `${name}.txt`);
      await writeFile(list, frames.map((f) => `file '${path.join(stills, `frame-${f}.png`).replace(/\\/g, "/")}'`).join("\n"));
      const row = path.join(dir, `${name}-row.png`);
      await run(ffmpegBin(), ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-vf", `tile=${frames.length}x1:padding=3:color=black`, "-frames:v", "1", row]);
      const labelled = path.join(dir, `${name}-label.png`);
      await label(row, labelled, text);
      rows.push(labelled);
    }
    await run(ffmpegBin(), ["-v", "error", "-y", "-i", rows[0], "-i", rows[1], "-filter_complex", "vstack=inputs=2", "-frames:v", "1", out]);
    console.log(`zoom-vs-axis: frames ${frames[0]}–${frames[frames.length - 1]} (cut at ${cut}) → ${out}`);

    if (args.includes("--export")) {
      const timed = async (label: string, timeline: Timeline) => {
        const output = path.join(dir, `${label}.mp4`);
        const started = Date.now();
        await renderReel({ timeline, assets, output, concurrency: 2 }, () => undefined);
        const seconds = (Date.now() - started) / 1000;
        console.log(`zoom-vs-axis: ${label} export ${seconds.toFixed(1)} s`);
        return seconds;
      };
      const plainTimeline: Timeline = { ...before, clips: before.clips.map((clip) => ({ ...clip, transitionIn: "cut" as const })) };
      const plain = await timed("plain", plainTimeline);
      const axis = await timed("axis", before);
      const zoom = await timed("zoom", after);
      console.log(`zoom-vs-axis: axis ${(axis / plain).toFixed(2)}×, zoom ${(zoom / plain).toFixed(2)}× the plain-cut export`);
    }
  } finally {
    server.close();
    if (!keep) await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
