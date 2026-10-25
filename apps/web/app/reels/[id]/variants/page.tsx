import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { VARIANT_HOOK_LABELS, type VariantHook } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { makeVariants } from "@/app/variant-actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { ExportAllVariants } from "@/components/export-all-variants";
import { BackIcon } from "@/components/icons";
import { LinkPending } from "@/components/link-pending";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { formatAgo, formatDuration } from "@/lib/format";
import { coverUrls, durationOf, readTimeline } from "@/lib/reels";
import { exportAllAllowance, findVariantSet, needsExport, refreshVariantInsights, type InsightsState } from "@/lib/variants";
import { getCurrentUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Variants · ReelWalk" };

const INSIGHTS_NOTE: Record<InsightsState, string> = {
  read: "Plays and reach from Instagram, read at most every ten minutes. The winner has the most plays once two or more are posted; an older post has had longer to collect them, so compare posts of a similar age.",
  unposted: "None of these is posted yet. The set is kept together, so once you post them their plays and reach show here and the winner is marked.",
  "no-connection": "Some are posted, but reading their numbers needs the Instagram Login connection on Account. The set is kept, so the numbers can be compared once it is connected.",
  permission: "Instagram needs a reconnect (Account, Reconnect Instagram) before it shares these numbers. The set is kept, so they can be compared after.",
  waiting: "Posted, but Instagram has no numbers for them yet. They are asked for again every ten minutes; if this lasts, reconnect Instagram on Account.",
};

const hookLabel = (hook: string) => VARIANT_HOOK_LABELS[hook as VariantHook] ?? hook;

/**
 * Variants of a reel (ADR 0063): three openings at 15 and 30 s, side by
 * side, each an ordinary reel to open, export and schedule; Export all; and
 * which one Instagram liked best once they are posted.
 */
export default async function VariantsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ made?: string; skipped?: string; exported?: string; error?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const user = await getCurrentUser();
  const reel = await prisma.reel.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { id: true, title: true, variant: { select: { groupId: true } } } });
  if (!reel) notFound();
  const set = await findVariantSet(user.workspaceId, reel.id);
  const timelines = set ? set.variants.map((variant) => readTimeline(variant.reel.timeline)) : [];
  // While exports render the page refreshes itself every 2 s: those refreshes show stored numbers and never ask Instagram.
  const active = set?.variants.some((variant) => ["QUEUED", "RUNNING"].includes(variant.reel.renderJobs[0]?.status ?? "")) ?? false;
  const [covers, insights, allowance] = set
    ? await Promise.all([coverUrls(timelines), refreshVariantInsights(user.workspaceId, set, { live: !active }), exportAllAllowance(user.workspaceId)])
    : [[], null, null];
  const toExport = set ? set.variants.filter((variant) => needsExport(variant.reel)).length : 0;
  // New sets are made from the source reel, never from a variant.
  const sourceId = set ? set.sourceReelId : reel.variant ? null : reel.id;
  const now = new Date();

  return (
    <main className="shell">
      <AutoRefresh active={active} />
      <header className="shell-head">
        <Link href={`/reels/${reel.id}`} className="btn btn-quiet" prefetch={false}>
          <BackIcon size={18} />
          Edit
        </Link>
        <span className="muted small">{set?.sourceReel?.title ?? reel.title}</span>
      </header>
      <h1 style={{ marginBottom: 4 }}>Variants</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Three openings, at 15 and 30 seconds, as new reels: the hero shot first, the presenter first, a title card first. Post them and see which one
        Instagram likes. Your reel stays as it is, and the variants use the same clips; nothing is copied.
      </p>

      {query.error ? (
        <p className="error small" role="alert" style={{ marginBottom: 12 }}>
          {query.error}
        </p>
      ) : null}
      {query.made ? (
        <p className="small" role="status" style={{ marginBottom: 8 }}>
          {query.made} variants made.
        </p>
      ) : null}
      {query.skipped ? (
        <ul className="muted small" style={{ marginBottom: 12, paddingLeft: 18 }} data-testid="variants-skipped">
          {query.skipped.split("\n").map((line) => {
            const [key, ...why] = line.split(": ");
            const [hook, length] = key.split("-");
            return (
              <li key={line}>
                Not made: {hookLabel(hook)}, {length} s. {why.join(": ")}
              </li>
            );
          })}
        </ul>
      ) : null}
      {query.exported ? (
        <p className="small" role="status" style={{ marginBottom: 12 }}>
          {query.exported === "0" ? "No new exports: each variant is already exported or exporting." : `${query.exported} exports started.`}
        </p>
      ) : null}

      {set ? (
        <>
          <ul className="variant-grid" data-testid="variant-grid">
            {set.variants.map((variant, index) => {
              const job = variant.reel.renderJobs[0];
              const numbers = insights?.numbers.get(variant.reelId);
              const winner = insights?.winner === variant.reelId;
              return (
                <li key={variant.reelId}>
                  <Link
                    href={job ? `/reels/${variant.reelId}/export` : `/reels/${variant.reelId}`}
                    className="reel-card"
                    prefetch={false}
                    data-winner={winner || undefined}
                    data-testid="variant-card"
                  >
                    <span className="reel-thumb">
                      {covers[index] ? <img src={covers[index]!} alt="" loading="lazy" /> : <span className="empty-frame">No media</span>}
                      {job ? <StatusBadge status={job.status} /> : null}
                      <span className="chip timecode reel-duration">{formatDuration(durationOf(timelines[index]))}</span>
                      <LinkPending />
                      <span className="reel-meta">
                        <span className="reel-card-title">
                          {winner ? "Winning · " : ""}
                          {hookLabel(variant.hook)}
                        </span>
                        <span className="reel-card-when">{variant.lengthS} s version</span>
                      </span>
                    </span>
                  </Link>
                  {numbers && (numbers.views !== null || numbers.reach !== null) ? (
                    <span className="variant-numbers" data-testid="variant-numbers">
                      {[
                        numbers.views !== null ? `${numbers.views.toLocaleString("en-AU")} plays` : null,
                        numbers.reach !== null ? `${numbers.reach.toLocaleString("en-AU")} reached` : null,
                        numbers.postedAt ? `posted ${formatAgo(numbers.postedAt, now)}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="muted small" style={{ margin: "14px 0" }} data-testid="variant-insights">
            {insights ? INSIGHTS_NOTE[insights.state] : null}
          </p>
          <ExportAllVariants groupId={set.id} back={reel.id} count={toExport} remaining={allowance?.remaining ?? null} atOnce={allowance?.atOnce ?? 0} />
          <p className="muted small" style={{ marginTop: 8 }}>
            Each export counts towards your plan like any other. Open a variant to change it, post it or schedule it.
          </p>
        </>
      ) : null}

      {sourceId ? (
        <form action={makeVariants} style={{ marginTop: 20 }}>
          <input type="hidden" name="reelId" value={sourceId} />
          <SubmitButton className={set ? "btn btn-quiet btn-block" : "btn btn-signal btn-block"} pendingLabel="Making variants…" testId="make-variants">
            {set ? "Make a new set from the reel as it is now" : "Make variants"}
          </SubmitButton>
        </form>
      ) : null}
    </main>
  );
}
