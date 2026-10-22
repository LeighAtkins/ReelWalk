"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Runs (or re-runs) the render checks for an export through the same route
 * an agent calls, `GET /api/renders/:id/checks?fresh=1`, then refreshes the
 * screen so the panel and the Post gate read the new result.
 */
export function RunChecks({ jobId, label = "Run checks", quiet = false }: { jobId: string; label?: string; quiet?: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<{ step: "idle" | "running" } | { step: "failed"; error: string }>({ step: "idle" });

  async function run() {
    setState({ step: "running" });
    try {
      const response = await fetch(`/api/renders/${encodeURIComponent(jobId)}/checks?fresh=1`, { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as { reason?: string; error?: string };
      if (!response.ok) {
        setState({ step: "failed", error: body.reason ?? body.error ?? `The checks did not run (${response.status}).` });
        return;
      }
      setState({ step: "idle" });
      router.refresh();
    } catch {
      setState({ step: "failed", error: "Could not reach ReelWalk. Try again." });
    }
  }

  return (
    <>
      <button className={quiet ? "link small" : "btn btn-quiet"} type="button" onClick={() => void run()} disabled={state.step === "running"} data-testid="run-checks">
        {state.step === "running" ? "Checking…" : label}
      </button>
      {state.step === "failed" ? (
        <span className="error small" role="alert">
          {" "}
          {state.error}
        </span>
      ) : null}
    </>
  );
}
