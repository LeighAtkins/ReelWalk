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
import { CurrencyScope } from "@/components/currency";
import { requestCurrency } from "@/lib/request-currency";
import { chargeableCurrency, isBillingConfigured, isIntervalAvailable, offeredCurrencies } from "@/lib/stripe";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Plans · ReelWalk",
  description: "Free, Agent and Studio plans for making listing reels on your phone. Australian dollars with GST in Australia, US dollars elsewhere.",
  openGraph: { type: "website", siteName: "ReelWalk", locale: "en_AU", title: "Plans · ReelWalk", description: "Your listing, as a reel, in a minute. Start free, no card; Agent and Studio plans when the reels earn their keep.", url: "/pricing", images: [OG_IMAGE] },
  twitter: { card: "summary_large_image", title: "Plans · ReelWalk", description: "Your listing, as a reel, in a minute. Start free, no card; Agent and Studio plans when the reels earn their keep.", images: [OG_IMAGE] },
};

/**
 * The plans on their own page. Signed out it is the landing page's pricing
 * section between its header and footer; signed in, the same cards open
 * Stripe Checkout at the chosen interval, inside the app's shell.
 */
export default async function PricingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getSessionUser();
  const resolution = await requestCurrency();
  const offered = offeredCurrencies();
  const currency = chargeableCurrency(resolution.currency);
  if (!user) {
    // Ad parameters on the link to /pricing travel on to sign-up (ADR 0080).
    const attribution = pickAttribution(await searchParams);
    return (
      <CurrencyScope className={styles.page} resolution={resolution} offered={offered}>
        <SiteHeader plansHref="#pricing" attribution={attribution} />
        <main className={styles.main}>
          <PricingSection viewer={{ signedIn: false, attribution }} currency={currency} offered={offered} />
        </main>
        <SiteFooter />
      </CurrencyScope>
    );
  }
  const current = await workspacePlan(user.workspaceId);
  const billingOn = isBillingConfigured();
  return (
    <>
      <CurrencyScope resolution={resolution} offered={offered}>
      <main className="shell">
        <p className="muted small" style={{ marginBottom: 0 }}>
          <Link href="/account">Back to Account</Link>
        </p>
        <PricingSection
          viewer={{ signedIn: true, currentPlan: current.id, billingOn, yearlyOn: billingOn && isIntervalAvailable("year", currency) }}
          currency={currency}
          offered={offered}
        />
      </main>
      </CurrencyScope>
      <TabBar />
    </>
  );
}
