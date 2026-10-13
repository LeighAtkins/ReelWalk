import Link from "next/link";
import { BILLING_INTERVALS, PLAN_IDS, PLANS, planPrice, yearlyPerMonth, type BillingInterval, type PlanDef, type PlanId } from "@reelwalk/core";
import { startCheckout } from "@/app/billing-actions";
import { CheckIcon } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import styles from "./landing.module.css";

/**
 * The three plans from @reelwalk/core, with a monthly/yearly switch that is
 * two radio buttons and a :has() rule: no script runs on this page.
 *
 * Signed out, every button leads to sign-up. Signed in (the /pricing page),
 * paid plans open Stripe Checkout at the chosen interval, and the plan the
 * studio is on says so.
 */
export type PricingViewer =
  | { signedIn: false }
  | { signedIn: true; currentPlan: PlanId; billingOn: boolean; yearlyOn: boolean };

export function PricingSection({ viewer, id = "pricing" }: { viewer: PricingViewer; id?: string }) {
  const yearlyOn = viewer.signedIn ? viewer.yearlyOn : true;
  return (
    <section className={styles.pricing} id={id} aria-labelledby={`${id}-title`} data-testid="pricing">
      <div className={styles.pricingHead}>
        <h2 id={`${id}-title`}>Plans</h2>
        <p className={styles.lede}>Start free, no card. Pay when the agents start asking for the next one.</p>
        {yearlyOn ? (
          <fieldset className={styles.interval} data-testid="interval">
            <legend className="visually-hidden">Billing interval</legend>
            {BILLING_INTERVALS.map((interval) => (
              <label key={interval} className={styles.intervalOption}>
                <input type="radio" name={`${id}-interval`} value={interval} defaultChecked={interval === "month"} />
                <span>{interval === "month" ? "Monthly" : "Yearly, two months free"}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
      </div>
      <ul className={styles.plans}>
        {PLAN_IDS.map((planId) => (
          <PlanCard key={planId} plan={PLANS[planId]} viewer={viewer} yearlyOn={yearlyOn} />
        ))}
      </ul>
    </section>
  );
}

function PlanCard({ plan, viewer, yearlyOn }: { plan: PlanDef; viewer: PricingViewer; yearlyOn: boolean }) {
  const paid = plan.priceUsd > 0;
  const featured = plan.id === "AGENT";
  return (
    <li className={styles.plan} data-featured={featured} data-testid={`plan-${plan.id.toLowerCase()}`}>
      <h3>{plan.name}</h3>
      <p className={styles.who}>{audience(plan)}</p>
      {paid ? (
        <>
          <Price plan={plan} interval="month" className={styles.monthly} />
          {yearlyOn ? <Price plan={plan} interval="year" className={styles.yearly} /> : null}
        </>
      ) : (
        <p className={styles.price}>
          <span className={styles.amount}>$0</span>
          <span className={styles.per}>for as long as you like</span>
        </p>
      )}
      <ul className={styles.features}>
        {features(plan).map((feature) => (
          <li key={feature}>
            <CheckIcon size={16} />
            {feature}
          </li>
        ))}
      </ul>
      <PlanAction plan={plan} viewer={viewer} yearlyOn={yearlyOn} />
    </li>
  );
}

function Price({ plan, interval, className }: { plan: PlanDef; interval: BillingInterval; className: string }) {
  const amount = planPrice(plan, interval);
  return (
    <p className={`${styles.price} ${className}`}>
      <span className={styles.amount}>${interval === "year" ? yearlyPerMonth(plan).toFixed(0) : amount}</span>
      <span className={styles.per}>{interval === "year" ? `a month, $${amount} billed yearly` : "a month, billed monthly"}</span>
    </p>
  );
}

function PlanAction({ plan, viewer, yearlyOn }: { plan: PlanDef; viewer: PricingViewer; yearlyOn: boolean }) {
  const paid = plan.priceUsd > 0;
  if (!viewer.signedIn) {
    return (
      <Link href="/signup" className={`btn btn-block ${plan.id === "AGENT" ? "" : "btn-quiet"}`} data-testid={`cta-${plan.id.toLowerCase()}`}>
        {paid ? `Start free, then ${plan.name}` : "Start free, no card"}
      </Link>
    );
  }
  if (viewer.currentPlan === plan.id) {
    return <p className={styles.current}>Your studio is on {plan.name}.</p>;
  }
  if (!paid) {
    return (
      <Link href="/account" className="btn btn-quiet btn-block">
        Manage in Account
      </Link>
    );
  }
  if (!viewer.billingOn) {
    return <p className={`${styles.current} muted`}>Upgrades open soon.</p>;
  }
  return (
    <>
      {BILLING_INTERVALS.filter((interval) => interval === "month" || yearlyOn).map((interval) => (
        <form key={interval} action={startCheckout} className={interval === "year" ? styles.yearly : styles.monthly}>
          <input type="hidden" name="plan" value={plan.id} />
          <input type="hidden" name="interval" value={interval} />
          <SubmitButton className={`btn btn-block ${plan.id === "AGENT" ? "" : "btn-quiet"}`} pendingLabel="Opening checkout…">
            {interval === "year" ? `Get ${plan.name}, yearly` : `Get ${plan.name}`}
          </SubmitButton>
        </form>
      ))}
    </>
  );
}

function audience(plan: PlanDef): string {
  switch (plan.id) {
    case "FREE":
      return "Try it on a listing or two.";
    case "AGENT":
      return "One photographer, every listing.";
    default:
      return "A studio, five people posting.";
  }
}

function features(plan: PlanDef): string[] {
  const size = plan.outputWidth === 1080 ? "1080×1920, Instagram's full size" : "720×1280 with a small ReelWalk mark";
  return [
    `${plan.exportsPerMonth} rendered reels a month`,
    `${plan.aiEditsPerMonth} changes asked for in words`,
    size,
    plan.instagram ? "Post to Instagram in one tap" : "Download, or share a link",
    `${plan.storageGb} GB for your photos and clips`,
    plan.seats > 1 ? `${plan.seats} people in one studio` : "Music with the beat already found",
  ];
}
