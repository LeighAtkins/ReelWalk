import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CriticFinding } from "@reelwalk/core";
import { CriticPanel } from "./critic-panel";
import { ExportSheet } from "./sheets";

// The Export sheet with the critic's findings (ADR 0062), rendered as the server would: the count in the
// title, a thumbnail, reason and one-tap fix per finding, Fix all for the safe ones, and Export anyway.

const findings: CriticFinding[] = [
  { id: "hook:opening", check: "hook", severity: "high", impact: "hook", reason: "Nothing changes in the first 1.5 s, so people scroll past before it gets going.", atMs: 0, clipId: "a", sourceMs: 0,
    fixes: [{ kind: "command", label: "Start on shot 3", command: { type: "moveClip", clipId: "c", toIndex: 0 }, safe: false }] },
  { id: "safe-zone:t", check: "safe-zone", severity: "high", impact: "hold", reason: "“Open Saturday” runs under the header.", atMs: 900, clipId: "a", sourceMs: 900, textId: "t", box: { x: 0.2, y: 0.02, w: 0.6, h: 0.05 },
    fixes: [{ kind: "command", label: "Move it in", command: { type: "updateText", textId: "t", patch: { y: 0.2 } }, safe: true }] },
  { id: "beat:cuts", check: "beat", severity: "low", impact: "hold", reason: "2 of 4 cuts land between beats of the song.", atMs: 3250, clipId: "b", sourceMs: 250,
    fixes: [{ kind: "command", label: "Snap to the beat", command: { type: "snapToBeat" }, safe: true }] },
];
const noop = () => undefined;

describe("the critic in the Export sheet", () => {
  it("says how many things to fix and keeps Export anyway", () => {
    const panel = createElement(CriticPanel, { findings, thumbs: { "safe-zone:t": "data:image/jpeg;base64,AAAA" }, checking: false, safeCount: 2, onFix: noop, onFixAll: noop, onShow: noop });
    const html = renderToStaticMarkup(createElement(ExportSheet, { issues: [], durationMs: 12000, busy: false, error: null, critic: panel, findingCount: findings.length, onExport: noop, onShowIssue: noop, onClose: noop }));
    expect(html).toContain("3 things to fix");
    expect(html).toContain("Export anyway");
    expect(html).toContain("Fix all (2)");
    expect(html.match(/data-testid="critic-finding"/g)).toHaveLength(3);
    expect(html).not.toContain("critic-more");
    expect(html).toContain("Move it in");
    expect(html).toContain('src="data:image/jpeg;base64,AAAA"');
    expect(html).toMatch(/class="critic-box" style="left:20%;top:2%;width:60%;height:5%"/);
  });

  it("shows three at a time, the rest one tap away", () => {
    const five = [...findings, { ...findings[2], id: "x1" }, { ...findings[2], id: "x2" }];
    const html = renderToStaticMarkup(createElement(CriticPanel, { findings: five, thumbs: {}, checking: false, safeCount: 4, onFix: noop, onFixAll: noop, onShow: noop }));
    expect(html.match(/data-testid="critic-finding"/g)).toHaveLength(3);
    expect(html).toContain(">2 more<");
  });

  it("with nothing found it says so and offers the plain export", () => {
    const panel = createElement(CriticPanel, { findings: [], thumbs: {}, checking: false, safeCount: 0, onFix: noop, onFixAll: noop, onShow: noop });
    const html = renderToStaticMarkup(createElement(ExportSheet, { issues: [], durationMs: 12000, busy: false, error: null, critic: panel, findingCount: 0, onExport: noop, onShowIssue: noop, onClose: noop }));
    expect(html).toContain("Export for Instagram");
    expect(html).toContain("Export video");
    expect(html).toContain("Looks good");
  });

  it("a blocking problem still blocks, and the critic waits behind it", () => {
    const panel = createElement(CriticPanel, { findings, thumbs: {}, checking: false, safeCount: 2, onFix: noop, onFixAll: noop, onShow: noop });
    const html = renderToStaticMarkup(createElement(ExportSheet, { issues: [{ level: "error", code: "too-short", message: "Reels must be at least 3s." }], durationMs: 2000, busy: false, error: null, critic: panel, findingCount: 3, onExport: noop, onShowIssue: noop, onClose: noop }));
    expect(html).toContain("Not ready to export");
    expect(html).not.toContain("critic-finding");
  });
});
