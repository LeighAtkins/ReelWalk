import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyCommand } from "../src/commands";
import { cutGrammarReport } from "../src/cut-grammar";
import type { PlannerAnalysis } from "../src/shot-facts";
import { clipSchema, parseTimeline } from "../src/timeline";

/**
 * The planner against the shot analysis contract's own fixture (ADR 0086, Reel 91's eight clips, synthetic samples):
 * runs once that fixture is on the branch (it lands with feat/shot-analysis), so the two sides cannot drift apart.
 */
const FIXTURE = fileURLToPath(new URL("../src/fixtures/shot-analysis-reel91.json", import.meta.url));
const ROOMS: Record<string, string> = { "4904": "kitchen", "4905": "aerial", "4906": "exterior", "4907": "living", "4908": "stairs", "4909": "view", "4910": "primary bedroom", "4911": "balcony" };

describe.skipIf(!existsSync(FIXTURE))("the planner on the shot analysis fixture", () => {
  it("reads every clip's analysis and plans a cut that passes the gate", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { clips: Record<string, { fileName: string; analysis: PlannerAnalysis }> };
    const entries = Object.entries(fixture.clips);
    const timeline = parseTimeline({ version: 1, texts: [], music: { assetId: "song", bpm: 111.9, beatOffsetMs: 0 }, clips: entries.map(([assetId, clip]) => clipSchema.parse({
      id: `c-${assetId}`, assetId, kind: "VIDEO", room: ROOMS[clip.fileName.replace(/\D/g, "")] ?? null, sourceStartMs: 0, sourceEndMs: 2000,
    })) });
    const result = applyCommand(timeline, { type: "planCut", analyses: Object.fromEntries(entries.map(([id, clip]) => [id, clip.analysis])) },
      { generation: 0, sourceDurationsMs: Object.fromEntries(entries.map(([id, clip]) => [id, clip.analysis.durationMs])) });
    expect(result.rejected).toBeUndefined();
    expect(cutGrammarReport(result.timeline).nakedCuts).toBe(0);
    expect(cutGrammarReport(result.timeline).pass).toBe(true);
  });
});
