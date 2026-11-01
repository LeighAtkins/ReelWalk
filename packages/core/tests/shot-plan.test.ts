import { describe, expect, it } from "vitest";
import {
  acceptPassed, acceptTake, checkTake, classify, nextPlanStep, planBlocked, planClips, planIssues, requestRedo, retryNote, shotPlanSchema,
  takeFrames, takePrompt, planTimeline, withTakeStarted, finalizePlan, phaseCredits, planCredits, extendFrom, aiShotSchema, aiOmniCostCents, aiTakeSize, AI_OMNI_MODEL, isOmniModel, keyframePrompt, CONTINUITY_TAKE_PROMPT, CONTINUITY_KEYFRAMES_PROMPT, type PlanShot, type PlanState, type ShotPlan,
} from "../src";

const frame = (description: string, extra: Record<string, unknown> = {}) => ({ description, ...extra });
const shot = (id: string, over: Partial<Record<string, unknown>> = {}) => ({
  id, purpose: "feature", place: `${id} room`, pov: "eye level", seconds: 4, motion: "push-in", action: "the camera flies forward",
  start: frame(`the ${id} from the doorway`), end: frame(`the far side of the ${id}`), transitionOut: { kind: "cut" }, ...over,
});

/** The demo reel's plan: a presenter hook, a flight through three rooms joined without cuts, then the terrace. */
function villa(): ShotPlan {
  return shotPlanSchema.parse({
    version: 1, title: "16 ways", look: "A contemporary Mediterranean villa: travertine, lime plaster, pale oak, late-afternoon sun.",
    outfit: "an oversized sage-green knit jumper and cream trousers",
    shots: [
      shot("hook", { purpose: "hook", place: "entrance hall", motion: "still", presenter: true, line: "Sixteen ways to hook viewers with a title.", start: frame("she stands in the hall, close, facing the camera"), end: frame("the same, she finishes the line"), transitionOut: { kind: "cut" } }),
      shot("hall", { place: "entrance hall", pov: "wide, eye level", seconds: 8, playSeconds: 4.8, start: frame("the hall, the arch to the kitchen ahead", { assetId: "kf-hall" }), end: frame("inside the kitchen, the island ahead", { assetId: "kf-kitchen" }), transitionOut: { kind: "continuous" } }),
      shot("kitchen", { place: "kitchen", seconds: 8, playSeconds: 4.8, start: frame("continuing", { source: "previous" }), end: frame("the bedroom, the terrace door ahead", { assetId: "kf-bedroom" }), transitionOut: { kind: "continuous" } }),
      shot("bedroom", { place: "bedroom", seconds: 8, playSeconds: 4.8, start: frame("continuing", { source: "previous" }), end: frame("the terrace and the pool", { assetId: "kf-terrace" }), transitionOut: { kind: "cut" } }),
      shot("outro", { purpose: "outro", place: "terrace", pov: "close", motion: "still", presenter: true, line: "All sixteen are built into ReelWalk.", start: frame("she stands by the pool, close", { assetId: "kf-outro" }), end: frame("she smiles", { source: "free" }) }),
    ],
  });
}
const withStills = (plan: ShotPlan): ShotPlan => ({ ...plan, shots: plan.shots.map((s) => ({ ...s, start: s.start.source === "keyframe" ? { ...s.start, assetId: s.start.assetId ?? `kf-${s.id}-a` } : s.start, end: s.end.source === "keyframe" ? { ...s.end, assetId: s.end.assetId ?? `kf-${s.id}-b` } : s.end })) });
const read = (rates: { tx?: number; ty?: number; zoom?: number; rotate?: number }) => classify({ tx: 0, ty: 0, zoom: 0, rotate: 0, ...rates });
const empty: PlanState = { shots: {}, storyboardApproved: false, assembled: false };
const credits = (s: PlanShot) => s.seconds / 4 + (s.line ? 1 : 0);

describe("planIssues", () => {
  it("passes the villa plan", () => {
    expect(planIssues(villa()).filter((i) => i.level === "error")).toEqual([]);
  });
  it("refuses a whip against the camera: the staircase spin that never spun", () => {
    const plan = shotPlanSchema.parse({ ...villa(), shots: [shot("a", { motion: "pan-left", transitionOut: { kind: "whip", direction: "right" } }), shot("b", { motion: "push-in" })] });
    const messages = planIssues(plan).map((i) => i.message);
    expect(messages.some((m) => m.includes("whip right needs this shot's camera turning right"))).toBe(true);
    expect(messages.some((m) => m.includes("open still turning right"))).toBe(true);
  });
  it("refuses the same room from the same spot twice in a row", () => {
    const plan = shotPlanSchema.parse({ ...villa(), shots: [shot("a", { place: "Kitchen" }), shot("b", { place: "kitchen" })] });
    expect(planIssues(plan)).toEqual([expect.objectContaining({ shotId: "b", level: "error", message: expect.stringContaining("same place from the same point of view") })]);
  });
  it("lets one room continue across a join (the same take in chunks)", () => {
    const plan = shotPlanSchema.parse({ ...villa(), shots: [shot("a", { place: "kitchen", transitionOut: { kind: "continuous" } }), shot("b", { place: "kitchen", start: frame("carrying on", { source: "previous" }) })] });
    expect(planBlocked(planIssues(plan))).toBe(false);
  });
  it("ties continuous joins to a start from the previous shot, both ways", () => {
    const loose = shotPlanSchema.parse({ ...villa(), shots: [shot("a", { transitionOut: { kind: "continuous" } }), shot("b")] });
    expect(planIssues(loose).map((i) => i.shotId)).toEqual(["b"]);
    const orphan = shotPlanSchema.parse({ ...villa(), shots: [shot("a"), shot("b", { start: frame("carrying on", { source: "previous" }) })] });
    expect(planIssues(orphan)[0].message).toContain("has to be continuous");
  });
  it("refuses a camera that reverses at a join with no cut", () => {
    const plan = shotPlanSchema.parse({ ...villa(), shots: [shot("a", { motion: "pan-left", transitionOut: { kind: "continuous" } }), shot("b", { motion: "pan-right", start: frame("carrying on", { source: "previous" }) })] });
    expect(planIssues(plan)[0].message).toContain("reverses");
  });
  it("warns when a reveal is already in view: the chandelier in the presenter's shot", () => {
    const plan = shotPlanSchema.parse({ ...villa(), shots: [
      shot("hook", { place: "hall", presenter: true, start: frame("she stands under the crystal chandelier in the hall") }),
      shot("look-up", { place: "hall", pov: "looking up", motion: "tilt-up", reveals: "crystal chandelier" }),
    ] });
    expect(planIssues(plan)).toEqual([expect.objectContaining({ shotId: "look-up", level: "warning" })]);
  });
  it("needs the presenter for a line, a planned start and room to say it", () => {
    const plan = shotPlanSchema.parse({ ...villa(), shots: [shot("a", { line: "One two three four five six seven eight nine ten eleven twelve" })] });
    const messages = planIssues(plan).map((i) => i.message);
    expect(messages).toContain("A spoken line needs the presenter in the shot.");
    expect(messages.some((m) => m.includes("too long"))).toBe(true);
  });
  it("needs a moving camera into a speed ramp and a matching move across a match cut", () => {
    const plan = shotPlanSchema.parse({ ...villa(), shots: [shot("a", { motion: "still", transitionOut: { kind: "speed-ramp" } }), shot("b", { motion: "pan-left", transitionOut: { kind: "match-cut" } }), shot("c", { motion: "pan-right" })] });
    const messages = planIssues(plan).map((i) => i.message);
    expect(messages.some((m) => m.includes("speed ramp needs the camera moving"))).toBe(true);
    expect(messages.some((m) => m.includes("does not match"))).toBe(true);
  });
});

describe("checkTake", () => {
  const hall = villa().shots[1];
  it("passes a take that pushes in and lands on its end frame", () => {
    expect(checkTake(hall, { motion: read({ zoom: 0.2 }), startChange: 0.01, endChange: 0.03 })).toEqual({ pass: true, problems: [], notes: [] });
  });
  it("fails a take that misses its end frame or goes the wrong way", () => {
    const missed = checkTake(hall, { motion: read({ zoom: 0.2 }), startChange: 0.01, endChange: 0.2 });
    expect(missed.problems).toEqual(["It does not land on the planned end frame."]);
    const pan = { ...hall, motion: "pan-right" as const };
    expect(checkTake(pan, { motion: read({ tx: 0.2 }), startChange: null, endChange: null }).problems[0]).toContain("wrong way: it turns left");
    expect(checkTake(pan, { motion: read({ tx: -0.2 }), startChange: null, endChange: null }).pass).toBe(true);
  });
  it("fails a still shot that moves and a moving shot that hardly does", () => {
    const still = { ...hall, motion: "still" as const };
    expect(checkTake(still, { motion: read({ tx: 0.3 }), startChange: null, endChange: null }).pass).toBe(false);
    expect(checkTake(hall, { motion: read({ zoom: 0.01 }), startChange: null, endChange: null }).problems[0]).toContain("hardly moves");
  });
  it("fails a take whose place changes even when both ends match, and corrects the retake for it", () => {
    const verdict = checkTake(hall, { motion: read({ zoom: 0.2 }), startChange: 0.01, endChange: 0.02, continuity: { consistent: false, problems: ["the white wall behind the island turns into open shelves"] } });
    expect(verdict.problems).toEqual(["The place changes during the take: the white wall behind the island turns into open shelves."]);
    expect(retryNote(hall, verdict)).toContain("only the camera moves");
  });
  it("asks the end keyframe to be the same place as the start, through its openings too", () => {
    const plan = withStills(villa());
    expect(keyframePrompt(plan, plan.shots[1], "end")).toContain("including what is seen through doorways, arches and windows");
    expect(keyframePrompt(plan, plan.shots[1], "start")).not.toContain("same place as the start frame");
    expect(CONTINUITY_TAKE_PROMPT).toContain("a wall becoming shelves");
    expect(CONTINUITY_KEYFRAMES_PROMPT).toContain("through doorways, arches and windows");
  });
  it("only notes a move it cannot read", () => {
    expect(checkTake(hall, { motion: null, startChange: null, endChange: null })).toMatchObject({ pass: true, notes: [expect.stringContaining("could not be read")] });
  });
  it("turns a failure into a correction for the retake", () => {
    const note = retryNote({ ...hall, motion: "pan-right" }, { pass: false, problems: ["The camera goes the wrong way: it turns left, planned pan-right.", "It does not land on the planned end frame."], notes: [] });
    expect(note).toContain("The camera must pan right: the camera flies forward");
    expect(note).toContain("Finish exactly on the supplied last frame");
  });
});

describe("running a plan", () => {
  const options = { approval: "storyboard" as const, budgetCredits: 100 };
  it("makes the storyboard first, then waits for its approval", () => {
    const step = nextPlanStep(villa(), empty, options, credits);
    expect(step).toEqual({ kind: "keyframes", frames: [{ shotId: "hook", end: "start" }, { shotId: "hook", end: "end" }] });
    expect(nextPlanStep(withStills(villa()), empty, options, credits)).toEqual({ kind: "wait", reason: "storyboard" });
  });
  it("makes one take at a time, in order, and only moves on once a take is accepted", () => {
    const plan = withStills(villa());
    let state: PlanState = { ...empty, storyboardApproved: true };
    expect(nextPlanStep(plan, state, options, credits)).toEqual({ kind: "take", shotId: "hook", attempt: 1, note: "" });
    state = withTakeStarted(state, "hook", { aiShotId: "g1", status: "generating", credits: 2 });
    expect(nextPlanStep(plan, state, options, credits)).toEqual({ kind: "wait", reason: "generating", shotId: "hook" });
    state.shots.hook.takes[0] = { ...state.shots.hook.takes[0], status: "checking", assetId: "ai-g1" };
    expect(nextPlanStep(plan, state, options, credits)).toEqual({ kind: "check", shotId: "hook", aiShotId: "g1" });
    state.shots.hook.takes[0] = { ...state.shots.hook.takes[0], status: "passed" };
    state = acceptPassed(plan, state, options);
    expect(state.shots.hook.acceptedAiShotId).toBe("g1");
    expect(nextPlanStep(plan, state, options, credits)).toMatchObject({ kind: "take", shotId: "hall" });
  });
  it("retries a failed take with the correction, then stops for the owner after three", () => {
    const plan = withStills(villa());
    let state: PlanState = { ...empty, storyboardApproved: true };
    const fail = { pass: false, problems: ["It does not land on the planned end frame."], notes: [] };
    for (let n = 1; n <= 3; n++) {
      const step = nextPlanStep(plan, state, options, credits);
      expect(step).toMatchObject({ kind: "take", shotId: "hook", attempt: n });
      if (n > 1) expect((step as { note: string }).note).toContain("Finish exactly on the supplied last frame");
      state = withTakeStarted(state, "hook", { aiShotId: `g${n}`, assetId: `ai-g${n}`, status: "failed", verdict: fail, credits: 2 });
    }
    expect(nextPlanStep(plan, state, options, credits)).toEqual({ kind: "wait", reason: "take-failed", shotId: "hook" });
    // The owner keeps one anyway: the plan moves on.
    state = acceptTake(state, "hook", "g2");
    expect(nextPlanStep(plan, state, options, credits)).toMatchObject({ kind: "take", shotId: "hall" });
  });
  it("waits for the owner after each passed take when asked, and stays inside the budget", () => {
    const plan = withStills(villa());
    let state: PlanState = withTakeStarted({ ...empty, storyboardApproved: true }, "hook", { aiShotId: "g1", assetId: "ai-g1", status: "passed", credits: 2 });
    state = acceptPassed(plan, state, { approval: "each-take" });
    expect(nextPlanStep(plan, state, { approval: "each-take", budgetCredits: 100 }, credits)).toEqual({ kind: "wait", reason: "take-approval", shotId: "hook" });
    state = acceptTake(state, "hook", "g1");
    expect(nextPlanStep(plan, state, { approval: "each-take", budgetCredits: 3 }, credits)).toEqual({ kind: "wait", reason: "budget", shotId: "hall" });
  });
  it("redoes a shot and every shot that continues from it, then assembles again", () => {
    const plan = withStills(villa());
    let state: PlanState = { ...empty, storyboardApproved: true, assembled: true };
    for (const s of plan.shots) state = acceptTake(withTakeStarted(state, s.id, { aiShotId: `g-${s.id}`, assetId: `ai-${s.id}`, status: "passed", credits: 2 }), s.id, `g-${s.id}`);
    state = { ...state, assembled: true };
    expect(nextPlanStep(plan, state, options, credits)).toEqual({ kind: "done" });
    const redo = requestRedo(plan, state, "hall", "bank right, not left");
    expect(redo.shotIds).toEqual(["hall", "kitchen", "bedroom"]);
    expect(nextPlanStep(plan, redo.state, options, credits)).toEqual({ kind: "take", shotId: "hall", attempt: 1, note: "bank right, not left" });
  });
});

describe("frames, prompts and the cut", () => {
  const plan = withStills(villa());
  const assets: Record<string, { assetId: string; durationMs: number }> = { "g-hall": { assetId: "ai-hall", durationMs: 8000 }, "g-kitchen": { assetId: "ai-kitchen", durationMs: 8000 } };
  const asset = (id: string) => assets[id] ?? null;
  it("continues from the accepted take's real last frame, else the planned keyframe", () => {
    expect(takeFrames(plan, empty, "kitchen", asset)).toEqual({ first: { assetId: "kf-kitchen", atMs: 0 }, last: { assetId: "kf-bedroom", atMs: 0 } });
    const state = acceptTake(withTakeStarted(empty, "hall", { aiShotId: "g-hall", assetId: "ai-hall", status: "passed", credits: 2 }), "hall", "g-hall");
    expect(takeFrames(plan, state, "kitchen", asset).first).toEqual({ assetId: "ai-hall", atMs: 7960 });
    expect(takeFrames(plan, empty, "outro", asset).last).toBeNull();
  });
  it("writes the look, the outfit and the frames into the take's prompt", () => {
    const prompt = takePrompt(plan, plan.shots[0], "Correction.");
    expect(prompt).toContain("She wears an oversized sage-green knit jumper");
    expect(prompt).toContain("travertine");
    expect(prompt.endsWith("Correction.")).toBe(true);
    expect(takePrompt(plan, plan.shots[2])).toContain("continuing the same camera move without a cut");
  });
  it("lays the accepted takes out at their planned lengths, skipping the repeated frame at a join", () => {
    let state: PlanState = empty;
    for (const id of ["hall", "kitchen"]) state = acceptTake(withTakeStarted(state, id, { aiShotId: `g-${id}`, assetId: `ai-${id}`, status: "passed", credits: 2 }), id, `g-${id}`);
    const clips = planClips(plan, state, asset);
    expect(clips.map((c) => [c.shotId, c.sourceStartMs, Number(c.speed.toFixed(3))])).toEqual([["hall", 0, 1.667], ["kitchen", 40, 1.658]]);
    const timeline = planTimeline(plan, state, asset);
    expect(timeline.clips.map((c) => [c.id, c.assetId, c.speed])).toEqual([["plan-hall", "ai-hall", 1.667], ["plan-kitchen", "ai-kitchen", 1.658]]);
  });
});

describe("drafts first, then final (ADR 0105)", () => {
  const plan = withStills(villa());
  const all = (state: PlanState, tier: "draft" | "final") => {
    let next = state;
    for (const s of plan.shots) next = acceptTake(withTakeStarted(next, s.id, { aiShotId: `${tier}-${s.id}`, assetId: `ai-${tier}-${s.id}`, status: "passed", credits: 1, tier }), s.id, `${tier}-${s.id}`);
    return next;
  };
  it("waits for the owner's review of the draft reel instead of finishing", () => {
    const drafted = { ...all({ ...empty, storyboardApproved: true, engine: "omni", phase: "draft" }, "draft"), assembled: true };
    expect(nextPlanStep(plan, drafted, { approval: "storyboard", budgetCredits: 100 }, phaseCredits(drafted))).toEqual({ kind: "wait", reason: "draft-review" });
    expect(phaseCredits(drafted)(plan.shots[0])).toBe(1);
  });
  it("finalising remakes every shot in order, keeps the drafts, then finishes", () => {
    const drafted = { ...all({ ...empty, storyboardApproved: true, engine: "omni", phase: "draft" }, "draft"), assembled: true };
    const final = finalizePlan(plan, drafted);
    expect(final.phase).toBe("final");
    expect(final.shots.hook).toMatchObject({ draftAiShotId: "draft-hook", acceptedAiShotId: undefined });
    expect(nextPlanStep(plan, final, { approval: "storyboard", budgetCredits: 100 }, phaseCredits(final))).toMatchObject({ kind: "take", shotId: "hook", attempt: 1 });
    expect(phaseCredits(final)(plan.shots[0])).toBe(2);
    const done = { ...all(final, "final"), assembled: true };
    expect(nextPlanStep(plan, done, { approval: "storyboard", budgetCredits: 100 }, phaseCredits(done))).toEqual({ kind: "done" });
  });
  it("refuses to finalise before every shot has an approved draft", () => {
    expect(() => finalizePlan(plan, { ...empty, engine: "omni", phase: "draft" })).toThrow(/approved draft first/);
  });
  it("prices an Omni plan as drafts of every shot, then one final each", () => {
    expect(planCredits(plan, "omni")).toEqual({ once: 5 + 10, withRetakes: 15 + 15 });
  });
});

describe("extending a take (ADR 0105)", () => {
  const open = shotPlanSchema.parse({ ...villa(), shots: [
    shot("hall", { place: "hall", transitionOut: { kind: "continuous" } }),
    shot("kitchen", { place: "kitchen", start: frame("carrying on", { source: "previous" }), end: frame("wherever it lands", { source: "free" }) }),
  ] });
  const voiced = shotPlanSchema.parse({ ...open, shots: [{ ...open.shots[0], presenter: true, line: "Sixteen ways to hook viewers." }, open.shots[1]] });
  const kept = (state: PlanState) => acceptTake(withTakeStarted(state, "hall", { aiShotId: "g1", assetId: "ai-g1", status: "passed", credits: 1 }), "hall", "g1");
  const omni: PlanState = { ...empty, engine: "omni" };
  it("extends a silent take when the next shot carries on with a free end", () => {
    expect(extendFrom(open, kept(omni), "kitchen", () => ({ durationMs: 8000, speechEndMs: null }))).toBe("g1");
  });
  it("never extends a take with speech in its last few seconds: the words would run on", () => {
    expect(extendFrom(voiced, kept(omni), "kitchen", () => ({ durationMs: 8000, speechEndMs: 7200 }))).toBeNull();
    expect(extendFrom(voiced, kept(omni), "kitchen", () => ({ durationMs: 8000, speechEndMs: null }))).toBeNull();
    expect(extendFrom(voiced, kept(omni), "kitchen", () => ({ durationMs: 8000, speechEndMs: 3500 }))).toBe("g1");
  });
  it("starts fresh from the last frame on Veo, or when the shot has a planned end still", () => {
    expect(extendFrom(open, kept(empty), "kitchen", () => ({ durationMs: 8000, speechEndMs: null }))).toBeNull();
    const planned = shotPlanSchema.parse({ ...open, shots: [open.shots[0], { ...open.shots[1], end: { description: "the island", source: "keyframe", assetId: "kf" } }] });
    expect(extendFrom(planned, kept(omni), "kitchen", () => ({ durationMs: 8000, speechEndMs: null }))).toBeNull();
  });
  it("keeps the sound only on shots with a line", () => {
    const plan = withStills(villa());
    let state: PlanState = empty;
    for (const id of ["hook", "hall"]) state = acceptTake(withTakeStarted(state, id, { aiShotId: `g-${id}`, assetId: `ai-${id}`, status: "passed", credits: 1 }), id, `g-${id}`);
    const timeline = planTimeline(plan, state, (id) => ({ assetId: `ai-${id.slice(2)}`, durationMs: 8000 }));
    expect(timeline.clips.map((c) => [c.id, c.volume])).toEqual([["plan-hook", 1], ["plan-hall", 0]]);
  });
});

describe("Omni shots", () => {
  it("lets an Omni draft have an end frame, and only Omni carry on from a take", () => {
    const frames = { first: { assetId: "a", atMs: 0 }, last: { assetId: "b", atMs: 0 } };
    expect(aiShotSchema.safeParse({ mode: "bridge", ...frames, tier: "draft", engine: "omni" }).success).toBe(true);
    expect(aiShotSchema.safeParse({ mode: "bridge", ...frames, tier: "draft" }).success).toBe(false);
    expect(aiShotSchema.safeParse({ mode: "custom", engine: "omni", extendOf: "gen1" }).success).toBe(true);
    expect(aiShotSchema.safeParse({ mode: "custom", extendOf: "gen1" }).success).toBe(false);
    expect(aiShotSchema.safeParse({ mode: "custom", engine: "omni", extendOf: "gen1", first: frames.first }).success).toBe(false);
  });
  it("prices and sizes Omni takes by tier", () => {
    expect(aiOmniCostCents(8, "draft")).toBe(24);
    expect(aiOmniCostCents(8, "final")).toBe(120);
    expect(aiTakeSize(AI_OMNI_MODEL, "draft")).toEqual({ width: 360, height: 640 });
    expect(isOmniModel("gemini-omni-1.1-flash")).toBe(true);
  });
});
