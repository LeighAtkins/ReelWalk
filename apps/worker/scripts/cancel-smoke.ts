/**
 * Cancellation smoke test (ADR 0050). Starts a real reel render (preflight,
 * then Remotion with headless Chrome) plus a long ffmpeg, all tied to one
 * attempt scope, stops the attempt at a tiny deadline, and then checks that
 * no Chrome, compositor or ffmpeg is left under this process and that the
 * attempt's temp dir is gone. Run it where the renderer runs (the worker image):
 *
 *   tsx scripts/cancel-smoke.ts [deadline-ms] [from-render]
 *
 * With `from-render` the deadline is counted from the first progress Remotion
 * reports, so it lands mid-render with Chrome and the compositor running;
 * otherwise from the start, where it may land in the bundle step.
 *
 * Exits non-zero if anything survived.
 */
import { existsSync } from "node:fs";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { parseTimeline } from "@reelwalk/core";
import { preflightReel, renderReel } from "@reelwalk/render/render-reel";
import { run } from "../src/library/tools";
import { abortAfter, AttemptStopped, createAttemptScope, descendantsOf, killDescendants, listProcesses, REMOTION_PROCESSES, runAttempt } from "../src/lifecycle";

const deadlineMs = Number(process.argv[2] ?? 8000);
const fromRender = process.argv[3] === "from-render";

async function tree(): Promise<string[]> {
  return descendantsOf(process.pid, await listProcesses()).map((proc) => `${proc.pid} <- ${proc.ppid} [${proc.state}] ${proc.command}`);
}

async function main() {
  const scope = createAttemptScope({ graceMs: 5000 });
  const dir = await scope.tempDir("reelwalk-cancel-smoke-");
  // A 40 s clip (small, so making it is quick), so the render is nowhere near done at the deadline.
  await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=270x480:rate=30:duration=40", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", path.join(dir, "walk.mp4")]);
  const server = http.createServer(async (request, response) => {
    const file = path.join(dir, path.basename(request.url ?? "/"));
    const info = await stat(file).catch(() => null);
    if (!info) return void response.writeHead(404).end();
    const range = /bytes=(\d*)-(\d*)/.exec(request.headers.range ?? "");
    const start = range?.[1] ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : info.size - 1;
    response.writeHead(range ? 206 : 200, { "content-type": "video/mp4", "accept-ranges": "bytes", "access-control-allow-origin": "*", "content-length": end - start + 1, ...(range ? { "content-range": `bytes ${start}-${end}/${info.size}` } : {}) });
    createReadStream(file, { start, end }).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const timeline = parseTimeline({
    version: 1,
    clips: [{ id: "c1", assetId: "walk", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 40_000, transitionIn: "cut" }],
    texts: [{ id: "t1", text: "CANCEL ME", startMs: 0, endMs: 40_000, x: 0.5, y: 0.4, style: "headline", animation: "none" }],
    music: null,
  });
  const assets = { walk: { src: `${url}/walk.mp4`, kind: "VIDEO" as const } };

  scope.own("remotion processes", (remainingMs) => killDescendants({ match: REMOTION_PROCESSES, graceMs: remainingMs }));
  let sample: ReturnType<typeof setTimeout> | undefined;
  let armedAt = 0;
  const arm = () => {
    armedAt = Date.now();
    abortAfter(scope, deadlineMs, () => new AttemptStopped(`Render attempt exceeded ${deadlineMs} ms`, "deadline"));
    sample = setTimeout(async () => console.log(`\ncancel-smoke: process tree just before the deadline:\n  ${(await tree()).join("\n  ") || "(none)"}`), Math.max(0, deadlineMs - 1000));
  };
  if (!fromRender) arm();

  const started = Date.now();
  try {
    await runAttempt(scope, async () => {
      // A long-running ffmpeg alongside the render, as normaliseLoudness or a re-encode would be.
      const ffmpeg = run("ffmpeg", ["-v", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "null", "-"], { scope }).catch((error: unknown) => error);
      await preflightReel({ timeline, assets, signal: scope.signal });
      console.log(`cancel-smoke: preflight done after ${Date.now() - started} ms, rendering`);
      await renderReel({ timeline, assets, output: path.join(dir, "out.mp4"), concurrency: 2, signal: scope.signal }, (fraction) => {
        if (fromRender && !armedAt && fraction > 0) arm();
        if (Math.round(fraction * 100) % 10 === 0) process.stdout.write(`${Math.round(fraction * 100)}% `);
      });
      await ffmpeg;
      return "finished";
    });
    console.log("cancel-smoke: the render finished before the deadline; use a smaller one");
    process.exitCode = 2;
  } catch (error) {
    clearTimeout(sample);
    if (!(error instanceof AttemptStopped)) {
      console.log(`cancel-smoke: the render failed on its own, not at the deadline:`, error);
      process.exitCode = 3;
    }
    const since = armedAt ? `${Date.now() - armedAt} ms after the deadline was armed` : `${Date.now() - started} ms after start (deadline never armed)`;
    console.log(`\ncancel-smoke: attempt settled ${since} (deadline ${deadlineMs} ms, grace ${scope.graceMs} ms): ${error instanceof Error ? `${error.name}: ${error.message.split("\n")[0]}` : error}`);
  } finally {
    server.close();
  }
  const left = await tree();
  console.log(`cancel-smoke: process tree after the attempt was reported:\n  ${left.join("\n  ") || "(none)"}`);
  console.log(`cancel-smoke: temp dir ${dir} ${existsSync(dir) ? "STILL EXISTS" : "removed"}; scope holds ${JSON.stringify(scope.held())}`);
  // A zombie ([Z]) has exited and holds nothing but its pid until Node reaps it; anything else is a survivor.
  const survivors = left.filter((line) => !line.includes("[Z]") && /chrome|headless|remotion|ffmpeg/i.test(line));
  if (survivors.length || existsSync(dir)) {
    console.log("cancel-smoke: FAILED, resources survived the attempt");
    process.exitCode = 1;
  } else if (process.exitCode === undefined) {
    console.log("cancel-smoke: ok, nothing survived");
  }
}

void main();
