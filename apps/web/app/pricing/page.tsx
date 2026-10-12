import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/landing/landing";
import styles from "@/components/landing/landing.module.css";
import { PricingSection } from "@/components/landing/pricing";
import { TabBar } from "@/components/tab-bar";
import { getSessionUser } from "@/lib/auth";
import { workspacePlan } from "@/lib/plans";
import { isBillingConfigured, isIntervalAvailable } from "@/lib/stripe";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Plans · ReelWalk",
  description: "Free, Agent and Studio plans for making listing reels on your phone. Monthly or yearly.",
};

/**
 * The plans on their own page. Signed out it is the landing page's pricing
 * section between its header and footer; signed in, the same cards open
 * Stripe Checkout at the chosen interval, inside the app's shell.
 */
export default async function PricingPage() {
  const user = await getSessionUser();
  if (!user) {
    return (
      <div className={styles.page}>
        <SiteHeader />
        <main className={styles.main}>
          <PricingSection viewer={{ signedIn: false }} />
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
