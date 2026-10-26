import { formatAud, PLANS, planPrice, type BillingInterval, type PlanId } from "@reelwalk/core";
import { planIntentOf, readAttribution } from "./attribution";

/**
 * The one message after a first successful export (ADR 0081): "Want this
 * every week? Agent plan: 40 exports a month, no watermark, AI polish." with
 * a checkout button and a dismiss. It is about the plan the visitor picked on
 * the pricing page ("Start free, then Studio"), else the Agent plan, and it
 * is shown once per studio (see `claimUpgradePrompt` in funnel.ts).
 */
export type FirstExportNudge = {
  plan: Exclude<PlanId, "FREE">;
  interval: BillingInterval;
  message: string;
  /** "A$39 a month, GST included." */
  price: string;
  button: string;
};

/** What to show a studio whose first export just finished, from the attribution stored at sign-up. */
export function firstExportNudge(storedAttribution: unknown, options: { yearlyAvailable: boolean }): FirstExportNudge {
  const intent = planIntentOf(readAttribution(storedAttribution));
  const plan = intent?.plan ?? "AGENT";
  // A yearly pick only holds while the yearly price is on sale; otherwise monthly.
  const interval: BillingInterval = intent?.interval === "year" && options.yearlyAvailable ? "year" : "month";
  const def = PLANS[plan];
  return {
    plan,
    interval,
    message: `Want this every week? ${def.name} plan: ${def.exportsPerMonth} exports a month, no watermark, AI polish.`,
    price: `${formatAud(planPrice(def, interval))} a ${interval}, GST included.`,
    button: `Get ${def.name}`,
  };
}
