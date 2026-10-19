import { describe, expect, it } from "vitest";
import { directorPlanSchema, sameTimeline, validateDirectorReferences, DIRECTOR_INSTRUCTIONS, DIRECTOR_PLAN_JSON_SCHEMA } from "../src/ai-director";
import { AI_EDIT_SYSTEM_PROMPT, applyAiEditPlan, clipSchema, emptyTimeline, parseTimeline } from "../src";

function plan() {
  return directorPlanSchema.parse({ note: "Keep the host visible", verdict: "needs-generation", issues: ["Presenter is too large relative to the doorway"], limitations: "Sampled frames only; no audio or continuous playback", checks: Object.fromEntries(["scale", "cameraContinuity", "presenterContinuity", "propertyIdentity"].map(k => [k, { result: "uncertain", evidence: "No complete source evidence" }])),  edit: { ops: [], note: "Wait for a better take", questions: [], caption: null }, shots: [{ title: "Continuous descent", reason: "Fix direction and scale", prompt: "One continuous overhead descent with human-scale presenter", durationSeconds: 8, first: { assetId: "house", atMs: 500 }, last: { assetId: "room", atMs: 0 } }] });
}
const assets = { house: { kind: "VIDEO", durationMs: 4000 }, room: { kind: "IMAGE", durationMs: null } };
describe("in-app Opus direction", () => {
  it("keeps a spoken line with a voice, and drops a voice without a line", () => {
    const base = plan().shots[0];
    const parse = (extra: Record<string, unknown>) => directorPlanSchema.parse({ ...plan(), shots: [{ ...base, ...extra }] }).shots[0];
    expect(parse({ line: "Worth dropping in.", voice: "veo" })).toMatchObject({ line: "Worth dropping in.", voice: "veo" });
    expect(parse({ line: "Worth dropping in.", voice: null })).toMatchObject({ voice: "lipsync" });
    expect(parse({ line: null, voice: "lipsync" })).toMatchObject({ line: null, voice: null });
  });
  it("keeps a composed keyframe only for an end that has a real frame and a presenter", () => {
    const base = plan().shots[0];
    const parse = (compose: unknown, last: unknown = base.last) => directorPlanSchema.parse({ ...plan(), shots: [{ ...base, last, compose }] }).shots[0].compose;
    expect(parse({ presenter: { assetId: "room", atMs: 0 }, first: "At the front door, head below the lintel.", last: null })).toEqual({ presenter: { assetId: "room", atMs: 0 }, first: "At the front door, head below the lintel.", last: null });
    expect(parse({ presenter: { assetId: "room", atMs: 0 }, first: null, last: "On the sofa, seat height." }, null)).toBeNull();
    expect(parse({ presenter: null, first: "At the front door, head below the lintel.", last: null })).toBeNull();
    expect(parse(null)).toBeNull();
    expect(() => validateDirectorReferences(directorPlanSchema.parse({ ...plan(), shots: [{ ...base, compose: { presenter: { assetId: "nobody", atMs: 0 }, first: "At the front door, head below the lintel.", last: null } }] }), assets)).toThrow("unavailable");
  });
  it("shortens a long edit note rather than discarding the review", () => {
    const raw = JSON.parse(JSON.stringify({ ...plan(), edit: { ops: [], note: "x".repeat(900), questions: [], caption: null } }));
    const parsed = directorPlanSchema.parse(raw);
    expect(parsed.edit.note.length).toBe(400); expect(parsed.edit.note.endsWith("…")).toBe(true);
  });
  it("accepts owned first/last frames without turning a proposal into edit operations", () => {
    const p = plan(); expect(() => validateDirectorReferences(p, assets)).not.toThrow();
    expect(p.edit.ops).toEqual([]); expect(p.shots[0].durationSeconds).toBe(8);
  });
  it("rejects foreign, audio and panoramic references", () => {
    expect(() => validateDirectorReferences(plan(), { room: assets.room })).toThrow("unavailable");
    expect(() => validateDirectorReferences(plan(), { ...assets, house: { kind: "AUDIO", durationMs: 4000 } })).toThrow("unavailable");
    expect(() => validateDirectorReferences(plan(), { ...assets, house: { ...assets.house, isPano: true } })).toThrow("unavailable");
  });
  it("rejects frames at or beyond the source end and photo timestamps", () => {
    const p = plan(); p.shots[0].first!.atMs = 4000;
    expect(() => validateDirectorReferences(p, assets)).toThrow("outside");
    p.shots[0].first!.atMs = 3999; p.shots[0].last!.atMs = 1;
    expect(() => validateDirectorReferences(p, assets)).toThrow("zero");
  });
  it("refuses unsupported lengths and oversize prompts, and turns last-frame-only shots into text-only shots", () => {
    const p = plan();
    expect(directorPlanSchema.safeParse({ ...p, shots: [{ ...p.shots[0], durationSeconds: 2 }] }).success).toBe(false);
    expect(directorPlanSchema.safeParse({ ...p, shots: [{ ...p.shots[0], prompt: "x".repeat(2001) }] }).success).toBe(false);
    const lastOnly = directorPlanSchema.safeParse({ ...p, shots: [{ ...p.shots[0], first: null }] });
    expect(lastOnly.success && lastOnly.data.shots[0].last).toBeNull();
  });
  it("makes human scale and presenter continuity explicit without claiming stills prove playback", () => {
    expect(DIRECTOR_INSTRUCTIONS).toContain("giant presenter");
    expect(DIRECTOR_INSTRUCTIONS).toContain("matching empty room");
    expect(DIRECTOR_INSTRUCTIONS).toContain("NOT a played video");
  });
  it("cannot declare a reel ready while a scale or continuity check failed or remains uncertain", () => {
    const p = plan();
    expect(directorPlanSchema.safeParse({ ...p, verdict: "ready" }).success).toBe(false);
    for (const c of Object.values(p.checks)) c.result = "pass";
    expect(directorPlanSchema.safeParse({ ...p, verdict: "ready" }).success).toBe(true);
    p.checks.scale.result = "fail";
    expect(directorPlanSchema.safeParse({ ...p, verdict: "ready" }).success).toBe(false);
  });
  it("shortens long prose instead of discarding a paid review", () => {
    const long = "The presenter stands as tall as the doorway. ".repeat(40);
    const check = { result: "fail", evidence: long };
    const plan = directorPlanSchema.parse({
      note: long, verdict: "changes-proposed", issues: Array.from({ length: 15 }, () => long), limitations: long,
      checks: { scale: check, cameraContinuity: check, presenterContinuity: check, propertyIdentity: check },
      edit: { ops: [], note: "No edits.", questions: [], caption: null }, shots: [],
    });
    expect(plan.checks.scale.evidence.length).toBeLessThanOrEqual(600);
    expect(plan.checks.scale.evidence.endsWith("…")).toBe(true);
    expect(plan.note.length).toBeLessThanOrEqual(1200);
    expect(plan.issues).toHaveLength(12);
  });
  it("treats the server's parsed copy of an unchanged timeline as the same edit", () => {
    const clip = clipSchema.parse({ id: "a", assetId: "v", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000 });
    const browser = { ...emptyTimeline(), clips: [Object.fromEntries(Object.entries(clip).reverse())] };
    const server = parseTimeline(browser);
    expect(JSON.stringify(server)).not.toBe(JSON.stringify(browser));
    expect(sameTimeline(server, browser)).toBe(true);
    expect(sameTimeline(server, { ...browser, clips: [{ ...clip, sourceEndMs: 2000 }] })).toBe(false);
  });
  it("tells Opus to keep one presenter voice and to put described changes in the plan", () => {
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/at most ONE AI take/);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/note may describe only changes that are actually in edit\.ops/);
    expect(DIRECTOR_INSTRUCTIONS).not.toMatch(/Return no edit operations when more evidence/);
  });
  it("asks for the edit and shots before the summary", () => {
    expect(Object.keys(DIRECTOR_PLAN_JSON_SCHEMA.properties)).toEqual(["edit", "shots", "checks", "issues", "verdict", "limitations", "note"]);
    expect(DIRECTOR_PLAN_JSON_SCHEMA.required).toEqual(["edit", "shots", "checks", "issues", "verdict", "limitations", "note"]);
  });
  it("numbers every operation from the description, even after a reorder", () => {
    expect(AI_EDIT_SYSTEM_PROMPT).toMatch(/numbers never change during a plan/);
    const clip = (id: string) => clipSchema.parse({ id, assetId: id, kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000 });
    const timeline = { ...emptyTimeline(), clips: [clip("roof"), clip("walk"), clip("front")] };
    const assets = Object.fromEntries(["roof", "walk", "front"].map(id => [id, { id, kind: "VIDEO" as const, title: id, durationMs: 8000, isPano: false, bpm: null, beatOffsetMs: null }]));
    const blank = { clip: null, text: null, startMs: null, endMs: null, lengthMs: null, speed: null, filter: null, motion: null, transition: null, fit: null, volume: null };
    // Front first, then remove clip 1 of the description (roof), not whatever sits first after the reorder.
    const result = applyAiEditPlan(timeline, { note: "", ops: [{ ...blank, op: "order", order: [3, 2] }, { ...blank, op: "remove", clip: 1 }] } as never, { assets, songs: [], newId: () => "n" });
    expect(result.timeline.clips.map(c => c.id)).toEqual(["front", "walk"]);
  });
  it("keeps a review whose shot has an ending frame but no starting frame, as a text-only shot", () => {
    const check = { result: "uncertain", evidence: "Not generated yet." };
    const plan = directorPlanSchema.parse({
      note: "One retry.", verdict: "needs-generation", issues: [], limitations: "Stills only.",
      checks: { scale: check, cameraContinuity: check, presenterContinuity: check, propertyIdentity: check },
      edit: { ops: [], note: "No edits.", questions: [], caption: null },
      shots: [{ title: "Retry", reason: "Fell level.", prompt: "Straight down onto the villa roof, small figure.", durationSeconds: 4, first: null, last: { assetId: "a", atMs: 0 } }],
    });
    expect(plan.shots[0].last).toBeNull();
  });
});
