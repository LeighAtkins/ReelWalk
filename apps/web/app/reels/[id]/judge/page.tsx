import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { judgeTimesMs, timelineDurationMs, VARIANT_HOOK_LABELS, type VariantHook } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { BackIcon } from "@/components/icons";
import { ChecksList } from "@/components/render-checks";
import { RunChecks } from "@/components/run-checks";
import { formatDuration } from "@/lib/format";
import { ensureChecks, exportTimeline, ffmpegAvailable, type ChecksResult } from "@/lib/render-verify";
import { findVariantSet } from "@/lib/variants";
import { getCurrentUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Judge · ReelWalk" };

/** Frames shown per reel, CSS px across (two and a half fit a 412 px phone, so the strip scrolls). */
const FRAME_W = 144;

type Entry = { reelId: string; title: string; label: string | null; jobId: string; durationMs: number; result: ChecksResult };

/**
 * The Judge view (ADR 0071): the reel and its variants (ADR 0063) side by
 * side, each as its opening (0, 0.5, 1, 1.5 s) and its last 1.5 s cut from
 * the export itself, with the render checks underneath. What a viewer sees
 * before deciding to stay, and what they see as it loops.
 */
export default async function JudgePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  const reel = await prisma.reel.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { id: true, title: true } });
  if (!reel) notFound();

  const set = await findVariantSet(user.workspaceId, reel.id);
  const siblings = set ? set.variants.filter((variant) => variant.reelId !== reel.id) : [];
  const reelIds = [reel.id, ...siblings.map((variant) => variant.reelId)];
  // Each reel's newest finished export, with its file and the timeline it was rendered from.
  const jobs = await prisma.renderJob.findMany({
    where: { workspaceId: user.workspaceId, reelId: { in: reelIds }, kind: "REEL", status: "SUCCEEDED", output: { isNot: null } },
    orderBy: { createdAt: "desc" },
    include: { output: true },
  });
  const newest = new Map<string, (typeof jobs)[number]>();
  for (const job of jobs) if (job.reelId && !newest.has(job.reelId)) newest.set(job.reelId, job);

  const entries: Entry[] = [];
  for (const reelId of reelIds) {
    const job = newest.get(reelId);
    if (!job?.output) continue;
    const variant = siblings.find((v) => v.reelId === reelId);
    const timeline = exportTimeline(job.payload);
    const result = await ensureChecks(job, { compute: false }).catch((): ChecksResult => ({ checks: null, source: "none", reason: "The checks could not be read." }));
    entries.push({
      reelId,
      title: variant ? variant.reel.title : reel.title,
      label: variant ? `${VARIANT_HOOK_LABELS[variant.hook as VariantHook] ?? variant.hook} · ${variant.lengthS} s` : set ? "the original" : null,
      jobId: job.id,
      durationMs: timeline ? timelineDurationMs(timeline) : result.checks?.durationMs ?? 0,
      result,
    });
  }
  const unexported = reelIds.length - entries.length;
  const frames = ffmpegAvailable();

  return (
    <main className="shell">
      <header className="shell-head">
        <Link href={`/reels/${reel.id}/export`} className="btn btn-quiet" prefetch={false}>
          <BackIcon size={18} />
          Export
        </Link>
        <span className="muted small">{reel.title}</span>
      </header>

      <section className="judge" data-testid="judge">
        <div>
          <h1>Judge</h1>
          <p className="muted small" style={{ marginTop: 6 }}>
            The opening a viewer decides on, and the last moment before it loops, cut from each export. Blocks are what stop a post.
            {unexported > 0 ? ` ${unexported} ${unexported === 1 ? "variant has" : "variants have"} no finished export yet.` : ""}
          </p>
          {!frames ? (
            <p className="error small" role="alert" data-testid="judge-no-ffmpeg">
              Frames need ffmpeg on this server; the checks below still show what the worker stored.
            </p>
          ) : null}
        </div>

        {entries.length === 0 ? (
          <p className="empty">No finished export to judge yet. Export the reel first.</p>
        ) : (
          entries.map((entry) => {
            const { opening, ending } = judgeTimesMs(entry.durationMs);
            const src = (ms: number) => `/api/renders/${entry.jobId}/frames?t=${ms}ms&w=${FRAME_W * 2}`;
            return (
              <article className="judge-reel" key={entry.reelId} data-testid="judge-reel" data-job={entry.jobId}>
                <div className="judge-head">
                  <h2>{entry.title}</h2>
                  <span className="muted small">
                    {entry.label ? `${entry.label} · ` : ""}
                    {formatDuration(entry.durationMs)}
                  </span>
                  <Link className="link small" href={`/reels/${entry.reelId}/export`} prefetch={false}>
                    Open
                  </Link>
                </div>
                {frames ? (
                  <div className="judge-strip" aria-label="Opening and ending frames">
                    {opening.map((ms) => (
                      <figure className="judge-frame" key={`o${ms}`} id={`t${ms}`}>
                        <img src={src(ms)} alt={`Frame at ${ms / 1000} s`} width={FRAME_W} height={Math.round((FRAME_W * 16) / 9)} loading="lazy" />
                        <figcaption>{(ms / 1000).toFixed(1)} s</figcaption>
                      </figure>
                    ))}
                    {ending.length ? <span className="judge-gap" aria-hidden /> : null}
                    {ending.map((ms, index) => (
                      <figure className="judge-frame" key={`e${ms}`} id={`t${ms}`}>
                        <img src={src(ms)} alt={`Frame at ${(ms / 1000).toFixed(2)} s`} width={FRAME_W} height={Math.round((FRAME_W * 16) / 9)} loading="lazy" />
                        <figcaption>{index === ending.length - 1 ? "last" : `−${((entry.durationMs - ms) / 1000).toFixed(1)} s`}</figcaption>
                      </figure>
                    ))}
                  </div>
                ) : null}
                {entry.result.checks ? (
                  <>
                    {entry.result.checks.blocked ? (
                      <p className="error small" role="alert">
                        Posting is blocked: {entry.result.checks.blockReasons[0]}
                      </p>
                    ) : null}
                    <ChecksList checks={entry.result.checks} />
                  </>
                ) : (
                  <p className="muted small">
                    {entry.result.reason ?? "The checks have not run for this export yet."} <RunChecks jobId={entry.jobId} />
                  </p>
                )}
              </article>
            );
          })
        )}
      </section>
    </main>
  );
}
