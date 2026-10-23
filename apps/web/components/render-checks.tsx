import Link from "next/link";
import type { RenderCheck, RenderChecks } from "@reelwalk/core";
import type { ChecksResult } from "@/lib/render-verify";
import { RunChecks } from "./run-checks";

const IMPACT_LABEL = { hook: "hook", hold: "hold", finish: "finish" } as const;

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} s`;

/** The checks of a render (ADR 0071) as a list: blocks first, each with its impact on the watch. */
export function ChecksList({ checks, judgeHref }: { checks: RenderChecks; judgeHref?: string }) {
  if (!checks.checks.length) {
    return (
      <p className="verify-clear small" data-testid="checks-clear">
        No black or empty frames, every title clear of the buttons, the loop and the bars in place.
      </p>
    );
  }
  return (
    <ul className="verify-list plain-list" data-testid="checks-list">
      {checks.checks.map((check: RenderCheck) => (
        <li key={check.id} className="verify-item" data-level={check.level} data-impact={check.impact}>
          <span className="verify-mark" aria-label={check.level === "block" ? "Blocks posting" : "Warning"} />
          <div className="verify-body">
            <div className="verify-head">
              <strong>{check.title}</strong>
              <span className="chip verify-impact">{IMPACT_LABEL[check.impact]}</span>
              {check.atMs !== undefined ? (
                judgeHref ? (
                  <Link className="link small" href={`${judgeHref}#t${Math.round(check.atMs)}`} prefetch={false}>
                    at {seconds(check.atMs)}
                  </Link>
                ) : (
                  <span className="muted small">at {seconds(check.atMs)}</span>
                )
              ) : null}
            </div>
            <span className="small">{check.detail}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The export screen's checks panel: what the worker found in the render,
 * whether it blocks Post and Schedule, and the way to the Judge view. For an
 * export verified before the checks existed, Run checks computes them.
 */
export function RenderChecksPanel({ jobId, reelId, result }: { jobId: string; reelId: string; result: ChecksResult }) {
  const judgeHref = `/reels/${reelId}/judge`;
  const checks = result.checks;
  return (
    <section className="verify" data-testid="render-checks" data-source={result.source} data-blocked={checks?.blocked ? "true" : "false"}>
      <div className="verify-title">
        <h2>Checks</h2>
        <Link className="btn btn-quiet" href={judgeHref} prefetch={false} data-testid="judge-link">
          Judge
        </Link>
      </div>
      {checks ? (
        <>
          {checks.blocked ? (
            <p className="error small" role="alert" data-testid="checks-blocked">
              Posting is blocked: {checks.blockReasons[0]}
              {checks.blockReasons.length > 1 ? ` (+${checks.blockReasons.length - 1} more)` : ""}. Fix it in the editor and export again, or post anyway below.
            </p>
          ) : null}
          <ChecksList checks={checks} judgeHref={judgeHref} />
          <p className="muted small verify-foot">
            {checks.facts.frames ? `${checks.facts.frames.count} frames read` : "Timeline only"}
            <span data-testid="checks-audio" data-available={checks.audio.available ? "true" : "false"}>
              {checks.audio.available
                ? checks.audio.problems.length
                  ? `, sound checked: ${checks.audio.problems.length} ${checks.audio.problems.length === 1 ? "problem" : "problems"} listed above`
                  : ", sound checked"
                : ", sound not checked"}
            </span>
            . <RunChecks jobId={jobId} label="Run again" quiet />
          </p>
        </>
      ) : (
        <p className="muted small" data-testid="checks-missing">
          {result.reason ?? "The checks have not run for this export yet."} <RunChecks jobId={jobId} label="Run checks" />
        </p>
      )}
    </section>
  );
}
