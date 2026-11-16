import Link from "next/link";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { CAMPAIGN_ROLE_LABELS, campaignFactsSchema, parseTimeline, parseReelExportPayload, timelineDurationMs, timelineGeneration, type CampaignRole } from "@reelwalk/core";
import { getCurrentUser } from "@/lib/workspace";
import { listingCampaign } from "@/lib/listing-campaigns";
import { outputUrls } from "@/lib/render-jobs";
import { CampaignFactsForm } from "@/components/campaign-facts-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { applyCampaign, exportCampaignCut, requestCampaignReview, revokeReview } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Campaign · ReelWalk" };
export default async function CampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; updated?: string; queued?: string }> }) {
  const user = await getCurrentUser();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const campaign = await listingCampaign(user.workspaceId, id);
  if (!campaign) notFound();
  const active = campaign.outputs.some((output) => output.reel.renderJobs.some((job) => job.status === "QUEUED" || job.status === "RUNNING"));
  const entries = await Promise.all(campaign.outputs.map(async (output) => {
    const generation = timelineGeneration(output.reel.timeline);
    const job = output.reel.renderJobs.find((entry) => timelineGeneration(parseReelExportPayload(entry.payload).timeline) === generation && entry.caption === output.reel.caption);
    const urls = job?.status === "SUCCEEDED" ? await outputUrls(job) : null;
    const approved = job && output.reviews.find((review) => !review.revokedAt && review.expiresAt > new Date() && review.approvedAt && review.exportId === job.id && review.reelRevision === output.reel.revision && review.factRevision === campaign.revision && review.caption === output.reel.caption);
    return { output, job, urls, approved };
  }));
  return <main style={{ maxWidth: 950, margin: "32px auto", padding: 20 }} data-testid="listing-campaign">
    {active ? <AutoRefresh active={active} /> : null}
    <Link href="/campaigns">← Campaigns</Link><h1>{campaign.title}</h1>
    <p>Shared facts version {campaign.revision + 1}. Three editable cuts reuse your accepted footage.</p>
    {query.error ? <p role="alert" className="error">{query.error}</p> : null}
    {query.updated ? <p role="status">Details updated across all three cuts. Export the new cuts before requesting review.</p> : null}
    {query.queued ? <p role="status">Export requested. Each finished cut has its own review and delivery.</p> : null}
    <section aria-label="Campaign outputs" style={{ display: "grid", gap: 24, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
      {entries.map(({ output, job, urls, approved }) => <article key={output.id} data-testid={`campaign-${output.role}`}>
        <h2>{CAMPAIGN_ROLE_LABELS[output.role as CampaignRole]}</h2>
        <p>{(timelineDurationMs(parseTimeline(output.reel.timeline)) / 1000).toFixed(1)} seconds · <Link href={`/reels/${output.reelId}`}>Edit cut</Link></p>
        {urls ? <video src={urls.playUrl} controls muted playsInline preload="metadata" style={{ width: "100%", maxHeight: 400 }} /> : <p role="status">{job ? job.status === "FAILED" ? "Export failed. Retry this cut." : `${job.status.toLowerCase()}…` : "Current cut needs an export."}</p>}
        <form action={exportCampaignCut}>
          <input type="hidden" name="campaignId" value={id} /><input type="hidden" name="reelId" value={output.reelId} />
          <input type="hidden" name="revision" value={output.reel.revision} /><input type="hidden" name="factRevision" value={campaign.revision} />
          <button className="btn" disabled={Boolean(urls) || job?.status === "QUEUED" || job?.status === "RUNNING"}>{urls ? "Current cut exported" : job?.status === "FAILED" ? "Retry export" : "Export cut"}</button>
        </form>
        {urls && job ? <>
          <p><a href={urls.downloadUrl} download>Download current preview</a> · <Link href={`/reels/${output.reelId}/export?v=${job.id}`}>Export details</Link></p>
          <form action={requestCampaignReview}><input type="hidden" name="campaignId" value={id} /><input type="hidden" name="outputId" value={output.id} /><input type="hidden" name="exportId" value={job.id} /><button className="btn btn-quiet">Create review link for this version</button></form>
          <p className="small">Opens a seven-day link pinned to this exact video and caption. Creating another link revokes the previous link.</p>
          {approved ? <section data-testid="approved-delivery"><strong>Approved by {approved.reviewerName}</strong><p><a className="btn" href={urls.downloadUrl} download>Download approved video</a></p><p style={{ whiteSpace: "pre-wrap" }}>{approved.caption}</p><p className="small">Approval applies only to this version. Reviewer names are self-reported.</p></section> : <p>Not approved for delivery.</p>}
        </> : null}
        {output.reviews.map((review) => <details key={review.id}><summary>{review.revokedAt ? "Revoked review" : review.expiresAt <= new Date() || review.reelRevision !== output.reel.revision || review.factRevision !== campaign.revision ? "Expired or superseded review" : review.approvedAt ? "Approved version" : "Awaiting review"}</summary>
          {review.comments.map((comment) => <p key={comment.id}><strong>{comment.name}</strong>: {comment.message}</p>)}
          {!review.revokedAt ? <form action={revokeReview}><input type="hidden" name="campaignId" value={id} /><input type="hidden" name="reviewId" value={review.id} /><button className="btn btn-quiet">Revoke link and approval</button></form> : null}
        </details>)}
      </article>)}
    </section>
    <section style={{ marginTop: 40 }}><h2>Shared listing details</h2><p>Preview the changes, then apply them to all three outputs. Separately edited facts or captions must be reconciled first.</p>
      <CampaignFactsForm key={`${campaign.revision}:${campaign.outputs.map((output) => `${output.reelId}-${output.reel.revision}`).join(":")}`} initial={campaignFactsSchema.parse(campaign.facts)} campaign={{ id, title: campaign.title, revision: campaign.revision, reels: Object.fromEntries(campaign.outputs.map((output) => [output.reelId, output.reel.revision])) }} requestKey={randomUUID()} action={applyCampaign} />
    </section>
  </main>;
}
