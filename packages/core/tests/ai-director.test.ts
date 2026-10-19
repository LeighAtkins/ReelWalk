import { describe, expect, it } from "vitest";
import { directorPlanSchema, sameTimeline, validateDirectorReferences, DIRECTOR_INSTRUCTIONS } from "../src/ai-director";
import { clipSchema, emptyTimeline, parseTimeline } from "../src";

function plan() {
  return directorPlanSchema.parse({ note: "Keep the host visible", verdict: "needs-generation", issues: ["Presenter is too large relative to the doorway"], limitations: "Sampled frames only; no audio or continuous playback", checks: Object.fromEntries(["scale", "cameraContinuity", "presenterContinuity", "propertyIdentity"].map(k => [k, { result: "uncertain", evidence: "No complete source evidence" }])),  edit: { ops: [], note: "Wait for a better take", questions: [], caption: null }, shots: [{ title: "Continuous descent", reason: "Fix direction and scale", prompt: "One continuous overhead descent with human-scale presenter", durationSeconds: 8, first: { assetId: "house", atMs: 500 }, last: { assetId: "room", atMs: 0 } }] });
}
const assets = { house: { kind: "VIDEO", durationMs: 4000 }, room: { kind: "IMAGE", durationMs: null } };
describe("in-app Opus direction", () => {
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
  it("refuses unsupported lengths, oversize prompts and last-frame-only shots", () => {
    const p = plan();
    expect(directorPlanSchema.safeParse({ ...p, shots: [{ ...p.shots[0], durationSeconds: 2 }] }).success).toBe(false);
    expect(directorPlanSchema.safeParse({ ...p, shots: [{ ...p.shots[0], prompt: "x".repeat(2001) }] }).success).toBe(false);
    expect(directorPlanSchema.safeParse({ ...p, shots: [{ ...p.shots[0], first: null }] }).success).toBe(false);
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
});
