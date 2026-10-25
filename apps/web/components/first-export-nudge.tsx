"use client";

import { useState } from "react";
import { startCheckout } from "@/app/billing-actions";
import { SubmitButton } from "@/components/submit-button";
import type { FirstExportNudge } from "@/lib/first-export-nudge";

/**
 * The one message after a first successful export (ADR 0081). The button
 * opens Stripe Checkout for the plan the visitor picked on the pricing page
 * (Agent by default); Not now just hides it. It is shown once per studio, by
 * the server, so a reload does not bring it back.
 */
export function FirstExportNudgeCard({ nudge }: { nudge: FirstExportNudge }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <section className="card export-nudge" aria-label="Upgrade" data-testid="first-export-nudge">
      <p className="export-nudge-message">{nudge.message}</p>
      <p className="muted small">{nudge.price}</p>
      <form action={startCheckout} className="export-nudge-actions">
        <input type="hidden" name="plan" value={nudge.plan} />
        <input type="hidden" name="interval" value={nudge.interval} />
        <input type="hidden" name="from" value="first-export" />
        <SubmitButton className="btn" pendingLabel="Opening checkout…" testId="first-export-nudge-checkout">
          {nudge.button}
        </SubmitButton>
        <button type="button" className="btn btn-quiet" onClick={() => setHidden(true)} data-testid="first-export-nudge-dismiss">
          Not now
        </button>
      </form>
    </section>
  );
}
