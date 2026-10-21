"use client";

import { useState } from "react";
import { exportAllSummary } from "@reelwalk/core";
import { exportAllVariants } from "@/app/variant-actions";
import { SubmitButton } from "./submit-button";

/**
 * Export all (ADR 0063) in two taps: the first says how many of the plan's
 * exports it uses, the second starts them. The server starts at most the
 * number confirmed here.
 */
export function ExportAllVariants({ groupId, back, count, remaining, atOnce }: { groupId: string; back: string; count: number; remaining: number | null; atOnce: number }) {
  const [asking, setAsking] = useState(false);
  if (count === 0) {
    return (
      <button type="button" className="btn btn-quiet btn-block" disabled data-testid="export-all-variants">
        Every variant is exported or exporting
      </button>
    );
  }
  if (!asking) {
    return (
      <button type="button" className="btn btn-signal btn-block" onClick={() => setAsking(true)} data-testid="export-all-variants">
        Export all ({count})
      </button>
    );
  }
  return (
    <form action={exportAllVariants} style={{ display: "grid", gap: 10 }} data-testid="export-all-confirm">
      <p className="small" role="status">
        {exportAllSummary(count, remaining, atOnce)}
      </p>
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="back" value={back} />
      <input type="hidden" name="confirmed" value={count} />
      <SubmitButton className="btn btn-signal btn-block" pendingLabel="Starting exports…" testId="export-all-go">
        Start {count} export{count === 1 ? "" : "s"}
      </SubmitButton>
      <button type="button" className="btn btn-quiet btn-block" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </form>
  );
}
