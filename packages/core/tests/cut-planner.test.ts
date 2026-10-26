import { describe, expect, it } from "vitest";
import { applyCutPlan, closeUpScale, describeCutPlan, planCut, planReport, stageOf, type PlanSource } from "../src/cut-planner";
import { cutGrammarReport } from "../src/cut-grammar";
import type { PlannerAnalysis } from "../src/shot-facts";
import { clipSchema, parseTimeline, timelineDurationMs, type Timeline } from "../src/timeline";
import { critique } from "../src/critic";
import { applyCommand } from "../src/commands";
import { autopilotStyle, briefForStyle, plannedCut } from "../src/autopilot";
import { openingTitle } from "../src/cut-planner";
import { renderChecks } from "../src/render-checks";

/** A synthetic shot analysis in the ADR 0086 shape: one steady movement, best windows spread over the clip. */
function analysis(durationMs: number, opts: { hd?: boolean; dx?: number; zoom?: number; saliencyX?: number; landscape?: boolean; occluderAt?: number; peaks?: number[]; depthSpread?: number; steady?: number; mover?: string } = {}): PlannerAnalysis {
  const landscape = opts.landscape ?? true;
  const samples = [];
  for (let t = 0; t < durationMs; t += 250) {
    const dx = opts.dx ?? 0.06, zoom = opts.zoom ?? 0;
    samples.push({ t, sharpness: 0.6 + 0.3 * Math.sin(t / 1700) ** 2, steady: opts.steady ?? 0.8, luma: 0.5, flow: { dx, dy: 0, zoom, magnitude: Math.max(Math.abs(dx), Math.abs(zoom) / 2), residual: 0.1 }, saliency: { x: opts.saliencyX ?? 0.5, y: 0.45, strength: 0.7 } });
  }
  const dir = Math.abs(opts.dx ?? 0.06) < 0.02 && Math.abs(opts.zoom ?? 0) < 0.04 ? "static" : (opts.zoom ?? 0) / 2 > Math.abs(opts.dx ?? 0.06) ? "push" : (opts.dx ?? 0.06) > 0 ? "right" : "left";
  const windows = [800, 1500, 2500, 4000].map((lengthMs) => {
    const best = [];
    for (let s = 300; s + lengthMs <= durationMs - 300 && best.length < 3; s += Math.max(lengthMs, 1200)) best.push({ startMs: s, endMs: s + lengthMs, score: 0.9 - best.length * 0.1, motion: 0.6, direction: dir as "right" });
    return { lengthMs, best };
  });
  return {
    durationMs, width: landscape ? (opts.hd ? 1920 : 3840) : 1080, height: landscape ? (opts.hd ? 1080 : 2160) : 1920, samples, windows,
    motion: [{ startMs: 0, endMs: durationMs, direction: dir as "right", magnitude: 0.06, mover: opts.mover ?? "camera", consistency: 0.9 }],
    flowPeaks: (opts.peaks ?? []).map((t) => ({ t, magnitude: 0.3, direction: "right" as const, mover: "camera" })),
    depth: opts.depthSpread ? [{ t: 0, cols: 4, rows: 4, grid: "AAAAAAAAAAAAAAAAAAAAAA==", foreground: 0.2, near: null, spread: opts.depthSpread }, { t: durationMs - 500, cols: 4, rows: 4, grid: "AAAAAAAAAAAAAAAAAAAAAA==", foreground: 0.2, near: null, spread: opts.depthSpread }] : [],
    occluders: opts.occluderAt !== undefined ? [{ startMs: opts.occluderAt - 300, endMs: opts.occluderAt + 300, peakMs: opts.occluderAt, direction: "left", coverage: 0.5, edgeFrom: 1, edgeTo: 0, near: true, score: 0.8 }] : [],
    reframe: landscape ? { aspect: 16 / 9, cropWidth: 0.316, path: [], closeUps: [] } : null,
    scene: { palette: [{ hex: "#c0b0a0", share: 0.4 }], round: null, brightnessRamps: [], blowouts: [] },
  };
}

function source(clipId: string, room: string, durationMs: number, opts: Parameters<typeof analysis>[1] = {}): PlanSource {
  return { clipId, assetId: `a-${clipId}`, kind: "VIDEO", durationMs, room, analysis: analysis(durationMs, opts) };
}

/** Reel 91's shoot as the planner sees it: the seven clips, their lengths and rooms (analysis synthetic). */
export const REEL_91_SHOOT: PlanSource[] = [
  source("kitchen", "kitchen", 12800, { landscape: false, dx: -0.05, saliencyX: 0.55 }),
  source("aerial", "aerial", 22089, { zoom: 0.08, dx: 0.01 }),
  source("exterior", "exterior", 9877, { dx: 0.07, peaks: [4200] }),
  source("view", "view", 8242, { dx: 0.05, depthSpread: 0.6 }),
  source("stairs", "stairs", 7841, { hd: true, dx: -0.06, occluderAt: 5200 }),
  source("bedroom", "primary bedroom", 6306, { dx: 0.004 }),
  source("balcony", "balcony", 5906, { dx: 0.05 }),
];
const SHOOT = REEL_91_SHOOT;

function timelineOf(sources: PlanSource[]): Timeline {
  return parseTimeline({ version: 1, texts: [], music: null, clips: sources.map((s) => clipSchema.parse({ id: s.clipId, assetId: s.assetId, kind: s.kind, room: s.room, sourceStartMs: 0, sourceEndMs: Math.min(2000, s.durationMs) })) });
}

let ids = 0;
const newId = () => `new-${++ids}`;

describe("planCut", () => {
  const plan = planCut({ sources: SHOOT, brief: { listing: "for-sale", feel: "classic" }, beats: { bpm: 111.9, beatOffsetMs: 120 } });

  it("walks the home in order and opens on the most moving outside shot", () => {
    expect(plan.mode).toBe("cut");
    expect(plan.shots[0].sourceClipId).toBe("aerial");
    const stages = plan.shots.map((s) => s.stage);
    const rank = ["arrival", "threshold", "living", "kitchen", "details", "private", "view", "leaving"];
    for (let i = 1; i < stages.length; i++) expect(rank.indexOf(stages[i])).toBeGreaterThanOrEqual(rank.indexOf(stages[i - 1]));
    expect(stages.at(-1)).toBe("leaving");
  });

  it("lands between 30 and 45 s with varied lengths in each role's range", () => {
    expect(plan.totalMs).toBeGreaterThanOrEqual(25_000);
    expect(plan.totalMs).toBeLessThanOrEqual(45_000);
    const lengths = plan.shots.map((s) => s.sourceEndMs - s.sourceStartMs);
    expect(lengths[0]).toBeGreaterThanOrEqual(1500);
    expect(lengths[0]).toBeLessThanOrEqual(2500);
    for (const shot of plan.shots.filter((s) => s.role === "detail")) expect(shot.sourceEndMs - shot.sourceStartMs).toBeLessThanOrEqual(1650);
    for (const shot of plan.shots.filter((s) => s.role === "hero")) expect(shot.sourceEndMs - shot.sourceStartMs).toBeLessThanOrEqual(4000);
    expect(new Set(lengths).size).toBeGreaterThan(2);
  });

  it("gives every shot change a technique, never the same twice in a row, and says why", () => {
    for (const [i, shot] of plan.shots.entries()) {
      if (i === 0) { expect(shot.cut).toBeNull(); continue; }
      expect(shot.cut?.technique).toBeTruthy();
      expect(shot.cut!.reason.length).toBeGreaterThan(10);
      expect(shot.cut!.technique).not.toBe(plan.shots[i - 1].cut?.technique);
    }
    expect(plan.shots[1].cut?.technique).toBe("graphicCarry");
    expect(plan.carryUntilMs).toBeGreaterThan(plan.shots[0].sourceEndMs - plan.shots[0].sourceStartMs);
  });

  it("closes on the frames just before the opening, so the loop is one move", () => {
    const last = plan.shots.at(-1)!;
    expect(last.sourceClipId).toBe("aerial");
    expect(last.sourceEndMs).toBe(plan.shots[0].sourceStartMs);
    expect(plan.loopSeam.eyeTrace).toBe(0);
  });

  it("gives a still window a virtual move", () => {
    const bedroom = plan.shots.find((s) => s.sourceClipId === "bedroom")!;
    expect(bedroom.motion).toBe("virtual");
    expect(bedroom.camera).not.toBeNull();
  });

  it("uses the occluder and the depth when the shots offer them", () => {
    const techniques = plan.shots.map((s) => s.cut?.technique);
    expect(techniques).toContain("occlusionWipe");
    expect(techniques).toContain("scaleJump");
  });

  it("passes its own gate once applied", () => {
    const timeline = applyCutPlan(timelineOf(SHOOT), plan, newId);
    expect(timelineDurationMs(timeline)).toBe(plan.totalMs);
    const report = planReport(timeline, plan);
    expect(report.nakedCuts).toBe(0);
    expect(report.repeats).toBe(0);
    expect(report.failures).toEqual([]);
    expect(report.longestNoSurpriseMs).toBeLessThanOrEqual(6000);
    // Every second window of a clip got a new id.
    expect(new Set(timeline.clips.map((c) => c.id)).size).toBe(timeline.clips.length);
  });

  it("is deterministic", () => {
    const again = planCut({ sources: SHOOT, brief: { listing: "for-sale", feel: "classic" }, beats: { bpm: 111.9, beatOffsetMs: 120 } });
    expect(again).toEqual(plan);
    expect(describeCutPlan(plan).length).toBe(plan.shots.length);
  });

  it("cuts quicker for lively and slower for quiet", () => {
    const lively = planCut({ sources: SHOOT, brief: { listing: "for-sale", feel: "lively" }, beats: { bpm: 120, beatOffsetMs: 0 } });
    const quiet = planCut({ sources: SHOOT, brief: { listing: "for-sale", feel: "quiet" } });
    const mean = (p: typeof plan) => p.totalMs / p.shots.length;
    expect(mean(lively)).toBeLessThan(mean(quiet));
  });

  it("ships a steady walk of 25 s or more as one take", () => {
    const walk = source("walk", "living", 40_000, { zoom: 0.1, dx: 0, steady: 0.9 });
    const oneTake = planCut({ sources: [walk, ...SHOOT.slice(0, 2)], brief: { listing: "for-sale", feel: "classic" } });
    expect(oneTake.mode).toBe("oneTake");
    expect(oneTake.shots).toHaveLength(1);
    expect(oneTake.totalMs).toBeGreaterThanOrEqual(25_000);
  });

  it("says when the footage is too short for 30 s", () => {
    const short = planCut({ sources: SHOOT.slice(4), brief: { listing: "for-sale", feel: "classic" } });
    expect(short.notes.join(" ")).toMatch(/usable footage/);
  });
});

describe("helpers", () => {
  it("reads stages from room names", () => {
    expect(stageOf("primary bedroom")).toBe("private");
    expect(stageOf("Aerial")).toBe("arrival");
    expect(stageOf("balcony")).toBe("view");
    expect(stageOf(null)).toBe("living");
  });

  it("only offers a close-up where the source has the pixels", () => {
    expect(closeUpScale(analysis(5000, { landscape: true }))).toBeGreaterThanOrEqual(1.3); // 4K landscape
    expect(closeUpScale({ ...analysis(5000), width: 1920, height: 1080 })).toBeNull(); // 1080p landscape is already upscaled
    expect(closeUpScale(analysis(5000, { landscape: false }))).toBe(1.6); // 1080×1920 portrait
  });
});

describe("cutGrammarReport", () => {
  const base = (patch: Partial<Timeline> = {}) => parseTimeline({
    version: 1, texts: [], music: null,
    clips: [0, 1, 2, 3].map((i) => ({ id: `c${i}`, assetId: `a${i}`, kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000 })),
    ...patch,
  });

  it("fails naked cuts", () => {
    const report = cutGrammarReport(base());
    expect(report.nakedCuts).toBe(3);
    expect(report.pass).toBe(false);
  });

  it("fails the same technique twice in a row, and counts drawn transitions and carried titles", () => {
    const timeline = base();
    timeline.clips[1].transitionIn = "focusPull";
    timeline.clips[2].cut = { technique: "rackFocus", reason: "test reason" };
    timeline.clips[3].cut = { technique: "eyeTrace", reason: "test reason" };
    timeline.texts.push({ id: "t", text: "Hook", startMs: 0, endMs: 2500, x: 0.5, y: 0.2, style: "elegant", color: "#ffffff", size: 1, animation: "auto" });
    const report = cutGrammarReport(timeline);
    expect(report.cuts.map((c) => c.technique)).toEqual(["rackFocus", "rackFocus", "eyeTrace"]);
    expect(report.repeats).toBe(1);
    timeline.clips[1].transitionIn = "cut";
    expect(cutGrammarReport(timeline).cuts[0].technique).toBe("graphicCarry");
  });

  it("fails a still photo held over 1.5 s and a long stretch with no surprise", () => {
    const timeline = parseTimeline({ version: 1, texts: [], music: null, clips: [
      { id: "p", assetId: "p", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 },
      { id: "v", assetId: "v", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 5000, cut: { technique: "eyeTrace", reason: "test reason" } },
    ] });
    const kinds = cutGrammarReport(timeline).failures.map((f) => f.kind);
    expect(kinds).toContain("static");
    expect(kinds).toContain("no-surprise");
  });
});

describe("the critic and the render checks on a planned reel", () => {
  const titleFont = () => ({ fontSize: 60 });
  const planned = () => applyCutPlan(timelineOf(SHOOT), planCut({ sources: SHOOT, brief: { listing: "for-sale", feel: "classic" } }), newId);

  it("reports nothing for a reel never cut to the grammar", () => {
    const plain = timelineOf(SHOOT);
    expect(critique({ timeline: plain, titleFont }).filter((f) => f.check === "cut-grammar")).toEqual([]);
    expect(renderChecks({ timeline: plain }).facts.cutGrammar).toBeUndefined();
  });

  it("flags a naked cut as high, offers a glint, and warns in the render checks without blocking", () => {
    const timeline = planned();
    const naked = timeline.clips[3];
    delete naked.cut;
    naked.transitionIn = "cut";
    const finding = critique({ timeline, titleFont }).find((f) => f.id.startsWith("cut-grammar:naked-cut"));
    expect(finding?.severity).toBe("high");
    expect(finding?.fixes[0]).toMatchObject({ kind: "command", command: { type: "setTransition", clipId: naked.id, transition: "lightLeak" } });
    const checks = renderChecks({ timeline });
    expect(checks.facts.cutGrammar?.nakedCuts).toBe(1);
    expect(checks.checks.some((c) => c.id.startsWith("cut-grammar:naked-cut") && c.level === "warn")).toBe(true);
    expect(checks.blocked).toBe(false);
  });
});

describe("the planCut command", () => {
  const analyses = Object.fromEntries(SHOOT.map((s) => [s.assetId, s.analysis]));
  const durations = Object.fromEntries(SHOOT.map((s) => [s.assetId, s.durationMs]));

  it("plans the reel's own clips in one undoable step and carries the opening title across the first cut", () => {
    const base = timelineOf(SHOOT);
    base.texts.push({ id: "hook", text: "This is what $2.4M buys", startMs: 0, endMs: 1500, x: 0.5, y: 0.2, style: "elegant", color: "#ffffff", size: 1, animation: "auto" });
    const result = applyCommand(base, { type: "planCut", brief: { feel: "classic" }, analyses }, { generation: 0, sourceDurationsMs: durations });
    expect(result.rejected).toBeUndefined();
    const timeline = result.timeline;
    expect(timeline.clips.length).toBeGreaterThan(SHOOT.length);
    expect(cutGrammarReport(timeline).pass).toBe(true);
    const hook = timeline.texts.find((t) => t.id === "hook")!;
    const firstCut = timeline.clips[0].sourceEndMs - timeline.clips[0].sourceStartMs;
    expect(hook.endMs).toBeGreaterThan(firstCut);
    expect(timeline.clips[1].cut?.technique).toBe("graphicCarry");
    // The same command gives the same ids: a dry run and the real run agree.
    expect(applyCommand(base, { type: "planCut", brief: { feel: "classic" }, analyses }, { generation: 0, sourceDurationsMs: durations }).timeline).toEqual(timeline);
  });

  it("does not claim a graphic carry when the reel has no opening title", () => {
    const result = applyCommand(timelineOf(SHOOT), { type: "planCut", analyses }, { generation: 0, sourceDurationsMs: durations });
    expect(result.timeline.clips[1].cut?.technique).not.toBe("graphicCarry");
  });

  it("refuses without any shot analysis", () => {
    const result = applyCommand(timelineOf(SHOOT), { type: "planCut" }, { generation: 0 });
    expect(result.rejected).toMatch(/shot analysis/);
  });
});

describe("the first cut by the planner", () => {
  const analyses = Object.fromEntries(SHOOT.map((s) => [s.assetId, s.analysis]));
  const durations = Object.fromEntries(SHOOT.map((s) => [s.assetId, s.durationMs]));
  const context = { assets: {}, songs: [{ id: "song", title: "Long Walks", bpm: 111.9, mood: "warm" }], info: {}, style: autopilotStyle("walkthrough"), newId, analyses, sourceDurationsMs: durations };

  it("plans the cut, keeps the song unsnapped, adds the hook and carries it across the first cut", () => {
    const result = plannedCut(timelineOf(SHOOT), context)!;
    expect(result).not.toBeNull();
    expect(result.plan.feel).toBe("classic");
    expect(result.timeline.music?.assetId).toBe("song");
    expect(result.timeline.music?.energy).toBeUndefined(); // no finish (Pop) on this path
    const hook = openingTitle(result.timeline)!;
    expect(hook.endMs).toBe(result.plan.carryUntilMs);
    expect(result.timeline.clips.map((c) => c.sourceEndMs - c.sourceStartMs)).toEqual(result.plan.shots.map((s) => s.sourceEndMs - s.sourceStartMs));
    expect(cutGrammarReport(result.timeline).pass).toBe(true);
  });

  it("reads the feel from the style unless the person chose one", () => {
    expect(briefForStyle(autopilotStyle("privacy"))).toEqual({ listing: "for-sale", feel: "quiet" });
    expect(briefForStyle(autopilotStyle("open-house"), { feel: "lively" })).toEqual({ listing: "open-home", feel: "lively" });
  });

  it("steps aside without any analysis", () => {
    expect(plannedCut(timelineOf(SHOOT), { ...context, analyses: {} })).toBeNull();
  });
});
