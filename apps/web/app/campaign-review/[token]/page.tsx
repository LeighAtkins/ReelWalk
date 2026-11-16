import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { readCampaignReview } from "@/lib/listing-campaigns";
import { respondReview } from "@/app/campaigns/actions";
import { CopyButton } from "@/components/copy-button";
import { appUrl } from "@/lib/app-url";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review this version · ReelWalk", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export default async function CampaignReviewPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const [{ token }, query] = await Promise.all([params, searchParams]);
  const review = await readCampaignReview(token);
  if (!review) notFound();
  const base = await appUrl();
  return <main style={{ maxWidth: 650, margin: "32px auto", padding: 20 }} data-testid="campaign-review">
    <h1>{review.output.campaign.title} · {review.output.role}</h1>
    <p>Review this exact video and caption. Listing facts version {review.factRevision + 1}. This private link expires {review.expiresAt.toLocaleDateString("en-GB")}.</p>
    <CopyButton text={`${base}/campaign-review/${token}`} label="Copy review link" copied="Review link copied" />
    <video src={review.urls.playUrl} controls muted playsInline preload="metadata" style={{ width: "100%", maxHeight: 600 }} />
    <p style={{ whiteSpace: "pre-wrap" }} data-testid="review-caption">{review.caption}</p>
    {query.error ? <p className="error" role="alert">{query.error}</p> : null}
    {query.saved ? <p role="status">Your response was saved for this version.</p> : null}
    {review.approvedAt ? <section data-testid="review-approved"><strong>Approved by {review.reviewerName}</strong><p><a className="btn" href={review.urls.downloadUrl} download>Save approved video</a></p><p>Copy the caption above with its credits and disclosures.</p></section> : <p>Awaiting approval.</p>}
    <section><h2>Feedback</h2>{review.comments.map((comment) => <p key={comment.id}><strong>{comment.name}</strong>: {comment.message}</p>)}</section>
    <form action={respondReview} className="stack">
      <input type="hidden" name="token" value={token} /><input type="hidden" name="requestKey" value={randomUUID()} />
      <label className="field">Your name<input name="name" className="text-input" required maxLength={80} /></label>
      <label className="field">Comment<textarea name="message" className="text-input" rows={4} maxLength={1200} /></label>
      <button className="btn btn-quiet" name="decision" value="comment">Request a change</button>
      <button className="btn" name="decision" value="approve">Approve this exact version</button>
    </form>
    <p className="small">Anyone holding this link can respond. Names are self-reported. A change request withdraws this link's current approval. Updated cuts need a new review link.</p>
  </main>;
}
