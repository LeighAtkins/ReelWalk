import Link from "next/link";
import { randomUUID } from "node:crypto";
import { prisma } from "@reelwalk/db";
import type { CampaignFacts } from "@reelwalk/core";
import { getCurrentUser } from "@/lib/workspace";
import { CampaignFactsForm } from "@/components/campaign-facts-form";
import { createCampaign } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Listing campaigns · ReelWalk" };
export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ error?: string; source?: string }> }) {
  const user = await getCurrentUser();
  const { error, source } = await searchParams;
  const [campaigns, recent, selected] = await Promise.all([
    prisma.listingCampaign.findMany({ where: { workspaceId: user.workspaceId }, orderBy: { updatedAt: "desc" }, take: 50 }),
    prisma.reel.findMany({ where: { workspaceId: user.workspaceId, campaignOutput: null }, orderBy: { updatedAt: "desc" }, take: 50, select: { id: true, title: true, revision: true } }),
    source ? prisma.reel.findFirst({ where: { id: source, workspaceId: user.workspaceId }, select: { id: true, title: true, revision: true } }) : null,
  ]);
  const sources = selected ? [selected, ...recent.filter((reel) => reel.id !== selected.id)] : recent;
  const initial: CampaignFacts = { address: "", price: "", beds: "", baths: "", area: "", contact: "", openHome: "", disclosure: "" };
  return <main className="container" style={{ maxWidth: 850, margin: "32px auto", padding: 20 }}>
    <Link href="/">← Studio</Link><h1>Listing campaigns</h1>
    <p>Turn one accepted reel into a Hero, Teaser and Open home campaign. Keep listing facts together and reuse the footage.</p>
    {error ? <p role="alert" className="error">{error}</p> : null}
    {source && !selected ? <p role="alert">The selected source reel is unavailable. Choose another accepted reel below.</p> : null}
    {campaigns.length ? <section><h2>Your campaigns</h2><ul>{campaigns.map((campaign) => <li key={campaign.id}><Link href={`/campaigns/${campaign.id}`}>{campaign.title}</Link></li>)}</ul></section> : null}
    <section><h2>Create a campaign</h2>
      {sources.length ? <CampaignFactsForm initial={initial} sources={sources} selectedSourceId={selected?.id} requestKey={randomUUID()} action={createCampaign} /> : <p>Create a reel and add accepted photos or video first. Then return here.</p>}
    </section>
  </main>;
}
