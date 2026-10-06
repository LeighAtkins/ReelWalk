/**
 * Load test: a day of real exports, compressed.
 *
 * Builds N tour reels from the ZInD home through the real UI (phone browser,
 * Server Actions), exports each one, and spreads the arrivals over the run
 * following a daily traffic curve (quiet night, lunch and evening peaks).
 * Meanwhile it samples the queue, the outbox and worker memory, optionally
 * kills a busy worker once, retries failed exports the way a user would, and
 * at the end checks every output: one job per reel, one output per job, the
 * object in storage with the recorded size, and a playable MP4 of the right
 * length. No message may be left in the outbox or the dead-letter queue.
 *
 *   docker compose up -d --scale worker=3
 *   LOAD_TOTAL=100 LOAD_MINUTES=120 LOAD_CHAOS=1 apps/worker/node_modules/.bin/tsx e2e/load/day.mts
 *   LOAD_RUN=<run> LOAD_VERIFY_ONLY=1 ...                  # re-check an earlier run from its state file
 *
 * State and the report go to .load/<run>/ so a run can be inspected later.
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, createWriteStream, readFileSync, existsSync } from "node:fs";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { chromium, devices, type BrowserContext } from "../node_modules/@playwright/test/index.mjs";
import { createRequire } from "node:module";
import { parseTimeline, timelineDurationMs, VIBES } from "../../packages/core/src/index.ts";
import { prisma } from "../../packages/db/src/index.ts";

const exec = promisify(execFile);
// The AWS SDK is a dependency of the worker, not of this package.
const workerRequire = createRequire(new URL("../../apps/worker/package.json", import.meta.url));
const { GetQueueAttributesCommand, SQSClient } = workerRequire("@aws-sdk/client-sqs") as typeof import("../../apps/worker/node_modules/@aws-sdk/client-sqs");
const { GetObjectCommand, HeadObjectCommand, S3Client } = workerRequire("@aws-sdk/client-s3") as typeof import("../../apps/worker/node_modules/@aws-sdk/client-s3");
const env = (key: string, fallback: string) => process.env[key] || fallback;

const TOTAL = Number(env("LOAD_TOTAL", "100"));
const MINUTES = Number(env("LOAD_MINUTES", "120"));
const CHAOS = env("LOAD_CHAOS", "1") === "1";
const SEED = Number(env("LOAD_SEED", "20261006"));
const BASE = env("LOAD_BASE_URL", "http://localhost:8080");
const MAX_PAGES = Number(env("LOAD_PAGES", "3"));
const SETTLE_MINUTES = Number(env("LOAD_SETTLE_MINUTES", "90"));
const run = env("LOAD_RUN", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
const dir = `.load/${run}`;
mkdirSync(`${dir}/videos`, { recursive: true });

// Arrivals per hour of a day, 0:00 to 23:00. Shape only; scaled to TOTAL.
const HOURLY = [2, 1, 1, 1, 1, 2, 3, 5, 6, 7, 7, 8, 9, 8, 7, 6, 6, 7, 9, 10, 9, 7, 5, 3];

const sqs = new SQSClient({ region: "us-east-1", endpoint: env("SQS_ENDPOINT_URL", "http://localhost:9324"), credentials: { accessKeyId: "local", secretAccessKey: "local" } });
const s3 = new S3Client({
  region: "us-east-1",
  endpoint: env("S3_ENDPOINT_URL", "http://localhost:9000"),
  forcePathStyle: true,
  credentials: { accessKeyId: env("S3_ACCESS_KEY_ID", "minioadmin"), secretAccessKey: env("S3_SECRET_ACCESS_KEY", "minioadmin") },
});
const BUCKET = env("S3_BUCKET", "reelwalk-dev");
const QUEUE = "http://localhost:9324/000000000000/render-jobs";
const DLQ = "http://localhost:9324/000000000000/render-jobs-dlq";

// ── Helpers ─────────────────────────────────────────────────────

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(SEED);

/** Arrival offsets in ms, sampled from the hourly curve and compressed into MINUTES. */
function schedule(total: number, minutes: number): number[] {
  const sum = HOURLY.reduce((a, b) => a + b, 0);
  const offsets: number[] = [];
  for (let i = 0; i < total; i++) {
    let r = random() * sum;
    let hour = 0;
    while (r >= HOURLY[hour]) r -= HOURLY[hour++];
    const dayFraction = (hour + random()) / 24;
    offsets.push(Math.round(dayFraction * minutes * 60_000));
  }
  return offsets.sort((a, b) => a - b);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line: string) => {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  appendFileSync(`${dir}/log.txt`, stamped + "\n");
};
const percentile = (values: number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

type Submission = { index: number; vibe: string; reelId: string; submittedAt: string; uiMs: number; retries: number };
const submissions: Submission[] = [];
const saveState = () => writeFileSync(`${dir}/state.json`, JSON.stringify({ run, TOTAL, MINUTES, SEED, submissions }, null, 2));

async function queueDepth(url: string) {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }),
  );
  return { visible: Number(Attributes?.ApproximateNumberOfMessages ?? 0), inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0) };
}

async function workerStats(): Promise<{ name: string; mem: string; cpu: string }[]> {
  const { stdout } = await exec("docker", ["stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}"]);
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.includes("worker"))
    .map((line) => {
      const [name, mem, cpu] = line.split("\t");
      return { name, mem: mem.split(" / ")[0], cpu };
    });
}

// ── Submitting through the UI ───────────────────────────────────

let openPages = 0;
async function submit(context: BrowserContext, index: number): Promise<void> {
  while (openPages >= MAX_PAGES) await sleep(250);
  openPages++;
  const page = await context.newPage();
  const vibe = index % (VIBES.length + 1) === 0 ? "" : VIBES[Math.floor(random() * VIBES.length)].id;
  const started = Date.now();
  try {
    await page.goto(`${BASE}/`);
    await page.getByTestId("vibe").selectOption(vibe);
    await page.getByTestId("auto-build").first().click();
    await page.waitForURL(/\/reels\/[^/]+$/);
    const reelId = page.url().split("/").pop()!;
    await page.getByTestId("clip").first().waitFor();
    await page.getByTestId("export-button").click();
    await page.getByTestId("confirm-export").click();
    await page.waitForURL(/\/export$/);
    const uiMs = Date.now() - started;
    submissions.push({ index, vibe: vibe || "neutral", reelId, submittedAt: new Date().toISOString(), uiMs, retries: 0 });
    saveState();
    log(`#${index} queued reel ${reelId} (${vibe || "neutral"}) in ${secs(uiMs)}`);
  } catch (error) {
    log(`#${index} SUBMIT FAILED: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
    await page.screenshot({ path: `${dir}/submit-${index}-failed.png` }).catch(() => {});
  } finally {
    await page.close();
    openPages--;
  }
}

/** A user's reaction to a failed export: tap "Retry export" once. */
async function retryFailed(context: BrowserContext): Promise<void> {
  const failed = await prisma.renderJob.findMany({
    where: { reelId: { in: submissions.map((s) => s.reelId) }, status: "FAILED" },
    select: { id: true, reelId: true, error: true, generation: true },
  });
  for (const job of failed) {
    const submission = submissions.find((s) => s.reelId === job.reelId)!;
    if (submission.retries >= 1) continue;
    submission.retries++;
    saveState();
    log(`reel ${job.reelId} FAILED (gen ${job.generation}: ${job.error?.slice(0, 120)}), retrying from the UI`);
    const page = await context.newPage();
    try {
      await page.goto(`${BASE}/reels/${job.reelId}/export`);
      await page.getByRole("button", { name: "Retry export" }).click();
      await page.getByTestId("export").and(page.locator("[data-status='QUEUED'], [data-status='RUNNING']")).waitFor({ timeout: 15_000 });
    } catch (error) {
      log(`retry of ${job.reelId} did not go through: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
    } finally {
      await page.close();
    }
  }
}

// ── Chaos: kill the worker that is rendering ────────────────────

async function killABusyWorker(): Promise<void> {
  const running = await prisma.renderJob.findFirst({ where: { reelId: { in: submissions.map((s) => s.reelId) }, status: "RUNNING" }, select: { id: true } });
  const { stdout } = await exec("docker", ["ps", "--filter", "name=worker", "--format", "{{.Names}}"]);
  const names = stdout.trim().split("\n").filter(Boolean);
  if (names.length === 0) return;
  // Which worker holds which job is not recorded, so pick one; with every
  // worker busy it is rendering something.
  const victim = names[Math.floor(random() * names.length)];
  log(`CHAOS: docker kill ${victim} (a RUNNING job: ${running?.id ?? "none"})`);
  await exec("docker", ["kill", victim]);
}

// ── Monitoring ──────────────────────────────────────────────────

type Sample = { at: string; queued: number; running: number; succeeded: number; failed: number; visible: number; inFlight: number; dlq: number; outbox: number; workers: string };
const samples: Sample[] = [];
let peakRunning = 0;

async function sample(): Promise<Sample> {
  const reelIds = submissions.map((s) => s.reelId);
  const [byStatus, queue, dlq, outbox, workers] = await Promise.all([
    prisma.renderJob.groupBy({ by: ["status"], where: { reelId: { in: reelIds } }, _count: true }),
    queueDepth(QUEUE),
    queueDepth(DLQ),
    prisma.outboxMessage.count(),
    workerStats().catch(() => []),
  ]);
  const count = (status: string) => byStatus.find((row) => row.status === status)?._count ?? 0;
  const s: Sample = {
    at: new Date().toISOString(),
    queued: count("QUEUED"),
    running: count("RUNNING"),
    succeeded: count("SUCCEEDED"),
    failed: count("FAILED"),
    visible: queue.visible,
    inFlight: queue.inFlight,
    dlq: dlq.visible + dlq.inFlight,
    outbox,
    workers: workers.map((w) => `${w.name.replace("reelwalk-", "")}=${w.mem}/${w.cpu}`).join(" "),
  };
  peakRunning = Math.max(peakRunning, s.running);
  samples.push(s);
  appendFileSync(`${dir}/samples.jsonl`, JSON.stringify(s) + "\n");
  return s;
}

// ── Verification ────────────────────────────────────────────────

type Problem = { reelId: string; what: string };

async function verify(): Promise<{ problems: Problem[]; summary: string }> {
  const problems: Problem[] = [];
  const reels = await prisma.reel.findMany({
    where: { id: { in: submissions.map((s) => s.reelId) } },
    include: { renderJobs: { include: { output: true } } },
  });
  if (reels.length !== submissions.length) problems.push({ reelId: "-", what: `${submissions.length} reels submitted, ${reels.length} found` });

  const waits: number[] = [];
  const renders: number[] = [];
  const sizes: number[] = [];
  let attemptsTotal = 0;
  let generationsTotal = 0;
  const probes: { reelId: string; file: string; expectMs: number }[] = [];

  for (const reel of reels) {
    if (reel.renderJobs.length !== 1) {
      problems.push({ reelId: reel.id, what: `${reel.renderJobs.length} render jobs (expected 1)` });
      continue;
    }
    const job = reel.renderJobs[0];
    generationsTotal += job.generation;
    if (job.status !== "SUCCEEDED") {
      problems.push({ reelId: reel.id, what: `job ${job.id} is ${job.status} (gen ${job.generation}, attempt ${job.attempt}): ${job.error ?? ""}` });
      continue;
    }
    if (!job.output) {
      problems.push({ reelId: reel.id, what: `job ${job.id} SUCCEEDED without an output row` });
      continue;
    }
    // attempt is the receive count of the winning delivery: 2+ means a redelivery (takeover or retry).
    attemptsTotal += job.attempt;
    if (job.output.objectKey !== `renders/${job.id}.mp4`) problems.push({ reelId: reel.id, what: `unexpected object key ${job.output.objectKey}` });
    if (job.startedAt) waits.push(job.startedAt.getTime() - job.createdAt.getTime());
    if (job.startedAt && job.finishedAt) renders.push(job.finishedAt.getTime() - job.startedAt.getTime());

    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: job.output.objectKey }));
      if (BigInt(head.ContentLength ?? 0) !== job.output.sizeBytes) {
        problems.push({ reelId: reel.id, what: `object is ${head.ContentLength} bytes, output row says ${job.output.sizeBytes}` });
      }
      sizes.push(Number(job.output.sizeBytes));
      const file = `${dir}/videos/${job.id}.mp4`;
      const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: job.output.objectKey }));
      await pipeline(object.Body as Readable, createWriteStream(file));
      probes.push({ reelId: reel.id, file: `${job.id}.mp4`, expectMs: timelineDurationMs(parseTimeline(reel.timeline)) });
    } catch (error) {
      problems.push({ reelId: reel.id, what: `object ${job.output.objectKey} missing or unreadable: ${error instanceof Error ? error.message : error}` });
    }
  }

  // Duration and decodability of every file, with ffprobe from the worker image.
  const videosDir = `${process.cwd()}/${dir}/videos`.replace(/\\/g, "/");
  const script = probes.map((p) => `echo "${p.file} $(ffprobe -v error -show_entries format=duration:stream=codec_name,width,height -of csv=p=0 /v/${p.file} | tr '\\n' ' ')"`).join("\n");
  writeFileSync(`${dir}/videos/probe.sh`, script + "\n");
  let probeOut = "";
  try {
    const { stdout } = await exec("docker", ["run", "--rm", "-v", `${videosDir}:/v`, "--entrypoint", "bash", "reelwalk-worker", "/v/probe.sh"], { maxBuffer: 10 * 1024 * 1024 });
    probeOut = stdout;
  } catch (error) {
    problems.push({ reelId: "-", what: `ffprobe run failed: ${error instanceof Error ? error.message.split("\n")[0] : error}` });
  }
  const durations: number[] = [];
  for (const p of probes) {
    const line = probeOut.split("\n").find((l) => l.startsWith(p.file + " "));
    if (!line) {
      problems.push({ reelId: p.reelId, what: `${p.file}: ffprobe gave no result` });
      continue;
    }
    // "<file> h264,1080,1920, aac, <duration>" with stream order varying.
    const fields = line.slice(p.file.length + 1).split(/[ ,]+/).filter(Boolean);
    const duration = Number(fields.at(-1));
    if (!fields.includes("h264") || !fields.includes("1080") || !fields.includes("1920")) problems.push({ reelId: p.reelId, what: `${p.file}: not 1080x1920 h264 (${line})` });
    if (!Number.isFinite(duration) || Math.abs(duration * 1000 - p.expectMs) > 1000) {
      problems.push({ reelId: p.reelId, what: `${p.file}: duration ${duration}s, timeline says ${(p.expectMs / 1000).toFixed(2)}s` });
    } else durations.push(duration);
  }

  const outbox = await prisma.outboxMessage.count();
  if (outbox > 0) problems.push({ reelId: "-", what: `${outbox} messages still in the outbox` });
  const dlq = await queueDepth(DLQ);
  if (dlq.visible + dlq.inFlight > 0) problems.push({ reelId: "-", what: `${dlq.visible + dlq.inFlight} messages in the dead-letter queue` });
  const orphans = await prisma.renderOutput.count({ where: { job: { is: null } } }).catch(() => 0);
  if (orphans > 0) problems.push({ reelId: "-", what: `${orphans} RenderOutput rows without a job` });

  const first = submissions[0] ? new Date(submissions[0].submittedAt).getTime() : 0;
  const lastFinished = Math.max(...reels.map((r) => r.renderJobs[0]?.finishedAt?.getTime() ?? 0));
  const retried = submissions.filter((s) => s.retries > 0).length;
  const summary = [
    `Reels submitted: ${submissions.length} of ${TOTAL} planned; succeeded: ${reels.filter((r) => r.renderJobs[0]?.status === "SUCCEEDED").length}; problems: ${problems.length}`,
    `Wall clock, first submit to last finish: ${((lastFinished - first) / 60_000).toFixed(1)} min; arrivals spread over ${MINUTES} min`,
    `UI submit time (home -> export screen): p50 ${secs(percentile(submissions.map((s) => s.uiMs), 50))}, p95 ${secs(percentile(submissions.map((s) => s.uiMs), 95))}, max ${secs(Math.max(...submissions.map((s) => s.uiMs)))}`,
    `Queue wait (created -> claimed): p50 ${secs(percentile(waits, 50))}, p95 ${secs(percentile(waits, 95))}, max ${secs(Math.max(0, ...waits))}`,
    `Render time (claimed -> finished): p50 ${secs(percentile(renders, 50))}, p95 ${secs(percentile(renders, 95))}, max ${secs(Math.max(0, ...renders))}`,
    `Video: ${durations.length} probed OK, duration ${Math.min(...durations).toFixed(1)}-${Math.max(...durations).toFixed(1)} s, size ${(Math.min(...sizes) / 1e6).toFixed(1)}-${(Math.max(...sizes) / 1e6).toFixed(1)} MB`,
    `Attempts: ${attemptsTotal} over ${renders.length} finished jobs (${attemptsTotal - renders.length} redeliveries); generations: ${generationsTotal - reels.length} manual retries on ${retried} reels`,
    `Peak concurrent RUNNING: ${peakRunning}; peak queue visible: ${Math.max(0, ...samples.map((s) => s.visible))}; peak outbox: ${Math.max(0, ...samples.map((s) => s.outbox))}`,
  ].join("\n");
  return { problems, summary };
}

// ── Main ────────────────────────────────────────────────────────

/** Waits for every submitted job to settle (sampling and retrying as it goes), then verifies and writes the report. */
async function waitAndVerify(context: BrowserContext | null) {
  const deadline = Date.now() + SETTLE_MINUTES * 60_000;
  while (Date.now() < deadline) {
    try {
      // A dropped database connection (Docker hiccup) is retried, not fatal.
      const active = await prisma.renderJob.count({ where: { reelId: { in: submissions.map((s) => s.reelId) }, status: { in: ["QUEUED", "RUNNING"] } } });
      const outbox = await prisma.outboxMessage.count();
      if (active === 0 && outbox === 0) break;
      const s = await sample();
      log(`status q=${s.queued} r=${s.running} ok=${s.succeeded} fail=${s.failed} | sqs ${s.visible}+${s.inFlight} dlq=${s.dlq} outbox=${s.outbox} | ${s.workers}`);
      if (context) await retryFailed(context);
    } catch (error) {
      log(`monitor error: ${error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 200) : error}`);
    }
    await sleep(30_000);
  }
  log("verifying outputs");
  const { problems, summary } = await verify();
  const problemList = problems.map((p) => `- ${p.reelId}: ${p.what}`).join("\n");
  const report = [
    `# Load test ${run}`,
    "",
    `${TOTAL} tour-reel exports through the UI, arrivals following a daily curve compressed into ${MINUTES} minutes${CHAOS ? ", one worker killed mid-run" : ""}.`,
    "",
    "```",
    summary,
    "```",
    "",
    problems.length === 0 ? "No problems found." : `## Problems (${problems.length})\n\n${problemList}`,
    "",
  ].join("\n");
  writeFileSync(`${dir}/report.md`, report);
  console.log("\n" + report);
  await prisma.$disconnect();
  process.exit(problems.length === 0 ? 0 : 1);
}

async function main() {
  if (env("LOAD_VERIFY_ONLY", "") === "1") {
    const state = JSON.parse(readFileSync(`${dir}/state.json`, "utf8"));
    submissions.push(...state.submissions);
    if (existsSync(`${dir}/samples.jsonl`)) {
      for (const line of readFileSync(`${dir}/samples.jsonl`, "utf8").split("\n").filter(Boolean)) {
        const s = JSON.parse(line) as Sample;
        samples.push(s);
        peakRunning = Math.max(peakRunning, s.running);
      }
    }
    log(`verify-only: ${submissions.length} submissions from ${dir}/state.json`);
    const browser = await chromium.launch();
    const context = await browser.newContext({ ...devices["Pixel 7"], deviceScaleFactor: 1 });
    await waitAndVerify(context);
    return;
  }
  log(`run ${run}: ${TOTAL} exports over ${MINUTES} min, seed ${SEED}, chaos ${CHAOS ? "on" : "off"}, base ${BASE}`);
  const offsets = schedule(TOTAL, MINUTES);
  writeFileSync(`${dir}/schedule.json`, JSON.stringify(offsets));
  const perHour = HOURLY.map((_, h) => offsets.filter((o) => Math.floor((o / (MINUTES * 60_000)) * 24) === h).length);
  log(`arrivals per compressed hour: ${perHour.join(" ")}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices["Pixel 7"], deviceScaleFactor: 1 });
  const start = Date.now();
  let chaosDone = !CHAOS;
  const chaosAt = start + MINUTES * 60_000 * 0.55;

  const monitor = (async () => {
    while (true) {
      await sleep(30_000);
      try {
        const s = await sample();
        log(`status q=${s.queued} r=${s.running} ok=${s.succeeded} fail=${s.failed} | sqs ${s.visible}+${s.inFlight} dlq=${s.dlq} outbox=${s.outbox} | ${s.workers}`);
        await retryFailed(context);
        if (!chaosDone && Date.now() >= chaosAt && s.running > 0) {
          chaosDone = true;
          await killABusyWorker();
        }
      } catch (error) {
        log(`monitor error: ${error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 200) : error}`);
      }
      if (finished) break;
    }
  })();
  let finished = false;

  const inFlight: Promise<void>[] = [];
  for (let i = 0; i < offsets.length; i++) {
    const wait = start + offsets[i] - Date.now();
    if (wait > 0) await sleep(wait);
    inFlight.push(submit(context, i));
  }
  await Promise.all(inFlight);
  log(`all ${submissions.length} submitted; waiting for the queue to drain`);

  // Let the monitor loop see the drain before it stops.
  const deadline = Date.now() + SETTLE_MINUTES * 60_000;
  while (Date.now() < deadline) {
    const active = await prisma.renderJob.count({ where: { reelId: { in: submissions.map((s) => s.reelId) }, status: { in: ["QUEUED", "RUNNING"] } } });
    const outbox = await prisma.outboxMessage.count();
    if (active === 0 && outbox === 0) break;
    await sleep(15_000);
  }
  finished = true;
  await monitor;
  await browser.close();
  await waitAndVerify(null);
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.stack : error}`);
  process.exit(2);
});
