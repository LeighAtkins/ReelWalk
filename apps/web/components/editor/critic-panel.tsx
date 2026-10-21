"use client";

import { useState } from "react";
import type { CriticFinding, CriticFix } from "@reelwalk/core";

/** The sheet stays short: the most important few first, the rest one tap away. */
const SHOWN = 3;

/**
 * The critic's findings in the Export sheet (ADR 0062): a picture of the
 * moment, one line of why, and the fix as one tap. "Fix all" applies the
 * safe ones (title moves and treatments, the beat snap) as one undo step.
 * Export anyway stays below, always available.
 */
export function CriticPanel({ findings, thumbs, checking, safeCount, onFix, onFixAll, onShow }: {
  findings: CriticFinding[];
  thumbs: Record<string, string>;
  checking: boolean;
  /** How many findings "Fix all" would fix. */
  safeCount: number;
  onFix(finding: CriticFinding, fix: CriticFix): void;
  onFixAll(): void;
  onShow(finding: CriticFinding): void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? findings : findings.slice(0, SHOWN);
  if (!findings.length && !checking) return <p className="critic-clear" data-testid="critic-clear">Looks good: opening, titles, pace and ending all check out.</p>;
  return (
    <section className="critic" aria-label="Before you export" data-testid="critic">
      <div className="critic-head">
        <span className="muted small" aria-live="polite">{checking ? "Looking at the frames…" : "Before you export"}</span>
        {safeCount > 1 ? (
          <button type="button" className="btn btn-quiet critic-fix-all" onClick={onFixAll} data-testid="critic-fix-all">
            Fix all ({safeCount})
          </button>
        ) : null}
      </div>
      <ul className="critic-list">
        {shown.map((finding) => (
          <li key={finding.id} className="critic-item" data-severity={finding.severity} data-check={finding.check} data-testid="critic-finding">
            <button type="button" className="critic-thumb" onClick={() => onShow(finding)} aria-label="Show this moment">
              {thumbs[finding.id] ? <img src={thumbs[finding.id]} alt="" /> : null}
              {finding.box ? (
                <span className="critic-box" style={{
                  left: pct(clamp(finding.box.x)), top: pct(clamp(finding.box.y)),
                  width: pct(clamp(finding.box.x + finding.box.w) - clamp(finding.box.x)),
                  height: pct(clamp(finding.box.y + finding.box.h) - clamp(finding.box.y)),
                }} />
              ) : null}
            </button>
            <div className="critic-body">
              <p className="critic-reason">{finding.reason}</p>
              <div className="critic-fixes">
                {finding.fixes.map((fix) => (
                  <button key={fix.label} type="button" className="btn btn-quiet critic-fix" onClick={() => onFix(finding, fix)} data-testid="critic-fix">
                    {fix.label}
                  </button>
                ))}
                {!finding.fixes.length ? (
                  <button type="button" className="btn btn-quiet critic-fix" onClick={() => onShow(finding)}>Show me</button>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {findings.length > shown.length ? (
        <button type="button" className="btn btn-quiet critic-more" onClick={() => setAll(true)} data-testid="critic-more">
          {findings.length - shown.length} more
        </button>
      ) : null}
    </section>
  );
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;
