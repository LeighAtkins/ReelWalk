import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { judgeTimesMs } from "@reelwalk/core";
import { computeChecks, contactSheet, findFfmpeg, framesAt, setFfmpeg, type VerifyDeps } from "./render-verify";

/**
 * The verification run against real exports (ADR 0071), for an agent or the
 * owner, off the app: public render URLs in, checks JSON and a Judge strip
 * out. Skipped unless asked for:
 *
 *   VERIFY_RENDERS="https://…/renders/a.mp4,https://…/renders/b.mp4" \
 *   VERIFY_OUT=/tmp/verify FFMPEG_PATH=/path/to/ffmpeg pnpm vitest run lib/render-verify.live
 *
 * Without a timeline (the job payload lives in the database) the checks are
 * the picture's alone: black and flash frames, frame 0, frozen pictures,
 * motion per second and the loop seam.
 */

const urls = (process.env.VERIFY_RENDERS ?? "").split(",").map((u) => u.trim()).filter(Boolean);
const out = process.env.VERIFY_OUT ?? path.join(process.cwd(), ".verify-out");

describe.skipIf(!urls.length)("render checks on real exports", () => {
  it("reads every render and writes its checks and Judge strip", async () => {
    if (process.env.FFMPEG_PATH) setFfmpeg(process.env.FFMPEG_PATH);
    expect(findFfmpeg(), "ffmpeg is needed (FFMPEG_PATH)").not.toBeNull();
    await mkdir(out, { recursive: true });
    const deps: VerifyDeps = {
      cacheRoot: path.join(out, "cache"),
      async download(objectKey, destination) {
        const response = await fetch(objectKey);
        if (!response.ok) throw new Error(`${response.status} for ${objectKey}`);
        await writeFile(destination, Buffer.from(await response.arrayBuffer()));
      },
      readJson: async () => null,
      putJson: async () => undefined,
    };
    const summary: Record<string, unknown>[] = [];
    for (const url of urls) {
      const id = path.basename(new URL(url).pathname, ".mp4");
      const started = Date.now();
      const checks = await computeChecks(url, null, deps);
      const { opening, ending } = judgeTimesMs(checks.durationMs);
      const frames = await framesAt(url, [...opening, ...ending], 216, deps);
      await writeFile(path.join(out, `${id}-judge.jpg`), await contactSheet(frames, 216));
      await writeFile(path.join(out, `${id}.checks.json`), JSON.stringify(checks, null, 2));
      const row = {
        id,
        durationMs: checks.durationMs,
        frames: checks.facts.frames,
        seconds: ((Date.now() - started) / 1000).toFixed(1),
        blocked: checks.blocked,
        checks: checks.checks.map((c) => `${c.level} ${c.title}${c.atMs !== undefined ? ` @${(c.atMs / 1000).toFixed(2)}s` : ""}: ${c.detail}`),
        openingBlack: checks.facts.openingBlack,
        openingEmpty: checks.facts.openingEmpty,
        flashFrames: checks.facts.flashFrames,
        black: checks.facts.black,
        frozen: checks.facts.frozen,
        loopSeamDiff: checks.facts.loopSeamDiff,
        motionPerSecond: checks.facts.motionPerSecond.map((m) => Number(m.toFixed(3))),
      };
      summary.push(row);
      console.log(JSON.stringify(row));
      expect(checks.facts.frames?.count ?? 0).toBeGreaterThan(0);
    }
    await writeFile(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
  }, 20 * 60_000);
});
