import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/landing/landing";
import styles from "@/components/landing/landing.module.css";
import { PricingSection } from "@/components/landing/pricing";
import { TabBar } from "@/components/tab-bar";
import { pickAttribution } from "@/lib/attribution";
import { getSessionUser } from "@/lib/auth";
import { workspacePlan } from "@/lib/plans";
import { OG_IMAGE } from "@/lib/site";
import { isBillingConfigured, isIntervalAvailable } from "@/lib/stripe";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Plans · ReelWalk",
  description: "Free, Agent (A$39 a month) and Studio (A$99 a month) plans for making listing reels on your phone. Australian dollars, GST included.",
  openGraph: { type: "website", siteName: "ReelWalk", locale: "en_AU", title: "Plans · ReelWalk", description: "Your listing, as a reel, in a minute. Free, Agent from A$39 a month, Studio from A$99. GST included.", url: "/pricing", images: [OG_IMAGE] },
  twitter: { card: "summary_large_image", title: "Plans · ReelWalk", description: "Your listing, as a reel, in a minute. Free, Agent from A$39 a month, Studio from A$99. GST included.", images: [OG_IMAGE] },
};

/**
 * The plans on their own page. Signed out it is the landing page's pricing
 * section between its header and footer; signed in, the same cards open
 * Stripe Checkout at the chosen interval, inside the app's shell.
 */
export default async function PricingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getSessionUser();
  if (!user) {
    // Ad parameters on the link to /pricing travel on to sign-up (ADR 0080).
    const attribution = pickAttribution(await searchParams);
    return (
      <div className={styles.page}>
        <SiteHeader plansHref="#pricing" attribution={attribution} />
        <main className={styles.main}>
          <PricingSection viewer={{ signedIn: false, attribution }} />
        </main>
        <SiteFooter />
      </div>
    );
  }
  const current = await workspacePlan(user.workspaceId);
  const billingOn = isBillingConfigured();
  return (
    <>
      <main className="shell">
        <p className="muted small" style={{ marginBottom: 0 }}>
          <Link href="/account">Back to Account</Link>
        </p>
        <PricingSection
          viewer={{ signedIn: true, currentPlan: current.id, billingOn, yearlyOn: billingOn && isIntervalAvailable("year") }}
        />
      </main>
      <TabBar />
    </>
  );
}
