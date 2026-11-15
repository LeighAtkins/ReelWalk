import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHOT_CINEMATOGRAPHY, emptyTimeline, insertShotCard, parseTimeline,
  referencedAssetIds, shotCards, shotFramePairSchema, updateShotCard,
  type CameraKeyframeInput, type ShotFramePair,
} from "@reelwalk/core";
import { activeEndRequestId, framePairIntent, framePairMatches, newEndRevision, newFramePair, savedEndRevisionInput, savedFramePairInput } from "./guided-frame-pair";
import { createDocumentStore } from "./editor/document-store";

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
];
function input(): CameraKeyframeInput {
  return {
    role: "start", source: { assetId: "house-reference", atMs: 0 }, move: "rise",
    distanceM: 3, durationSeconds: 4, prompt: "  Keep the blue roof.  ",
    cinematography: { ...DEFAULT_SHOT_CINEMATOGRAPHY },
  };
}
function pair(): ShotFramePair {
  let index = 0;
  return newFramePair(input(), () => ids[index++], new Date("2026-11-15T04:00:00.000Z"));
}
function cardTimeline(sourceAssetId = "house-reference") {
  return updateShotCard(insertShotCard(emptyTimeline(), "exterior"), "exterior", card => ({ ...card, sourceAssetId }));
}

describe("guided frame-pair intent", () => {
  it("freezes canonical controls and distinct operation identities without mutating the draft", () => {
    const draft = input();
    const before = structuredClone(draft);
    let index = 0;
    const created = newFramePair(draft, () => ids[index++], new Date("2026-11-15T04:00:00.000Z"));
    expect(draft).toEqual(before);
    expect([created.id, created.startRequestId, created.endRequestId]).toEqual(ids);
    expect(new Set([created.id, created.startRequestId, created.endRequestId]).size).toBe(3);
    expect(created.requestedAt).toBe("2026-11-15T04:00:00.000Z");
    expect(savedFramePairInput(created)).toMatchObject({
      role: "start", prompt: "Keep the blue roof.", source: before.source,
      guidedPair: { version: 1, id: ids[0], endRequestId: ids[2] },
      cinematography: DEFAULT_SHOT_CINEMATOGRAPHY,
    });
    draft.source.assetId = "replacement";
    draft.cinematography!.lensMm = 50;
    expect(savedFramePairInput(created).source.assetId).toBe("house-reference");
    expect(savedFramePairInput(created).cinematography!.lensMm).toBe("source");
  });

  it("canonicalizes property order, trimmed notes and request metadata when matching a review", () => {
    const draft = input();
    const reordered: CameraKeyframeInput = {
      cinematography: { whiteBalanceKelvin: "source", lensMm: "source", version: 1 },
      prompt: "Keep the blue roof.", durationSeconds: 4, distanceM: 3, move: "rise",
      source: { atMs: 0, assetId: "house-reference" }, role: "start",
      guidedPair: { version: 1, id: ids[2], endRequestId: ids[0] },
    };
    expect(framePairIntent(reordered)).toBe(framePairIntent(draft));
    expect(framePairMatches(pair(), reordered)).toBe(true);
  });

  it.each([
    ["source", (value: CameraKeyframeInput) => { value.source.assetId = "other-house"; }],
    ["move", (value: CameraKeyframeInput) => { value.move = "orbit"; }],
    ["distance", (value: CameraKeyframeInput) => { value.distanceM = 5; }],
    ["duration", (value: CameraKeyframeInput) => { value.durationSeconds = 8; }],
    ["lens", (value: CameraKeyframeInput) => { value.cinematography!.lensMm = 35; }],
    ["white balance", (value: CameraKeyframeInput) => { value.cinematography!.whiteBalanceKelvin = 5000; }],
    ["notes", (value: CameraKeyframeInput) => { value.prompt = "Change to dusk."; }],
  ] as const)("invalidates reviewed frames when %s changes", (_label, change) => {
    const changed = input();
    change(changed);
    expect(framePairMatches(pair(), changed)).toBe(false);
  });

  it.each([
    ["broken JSON", (value: ShotFramePair) => ({ ...value, input: "{" })],
    ["different source", (value: ShotFramePair) => ({ ...value, sourceAssetId: "other-house" })],
    ["different pair", (value: ShotFramePair) => ({ ...value, id: ids[2] })],
    ["different End identity", (value: ShotFramePair) => ({ ...value, endRequestId: ids[0] })],
    ["duplicate requests", (value: ShotFramePair) => ({ ...value, startRequestId: value.endRequestId })],
    ["missing recipe", (value: ShotFramePair) => {
      const frozen = JSON.parse(value.input);
      delete frozen.cinematography;
      return { ...value, input: JSON.stringify(frozen) };
    }],
    ["wrong role", (value: ShotFramePair) => ({ ...value, input: JSON.stringify({ ...JSON.parse(value.input), role: "end" }) })],
    ["missing guided metadata", (value: ShotFramePair) => {
      const frozen = JSON.parse(value.input);
      delete frozen.guidedPair;
      return { ...value, input: JSON.stringify(frozen) };
    }],
  ] as const)("rejects %s instead of permitting a stale review", (_label, corrupt) => {
    const invalid = corrupt(pair());
    expect(() => savedFramePairInput(invalid)).toThrow();
    expect(framePairMatches(invalid, input())).toBe(false);
  });

  it("does not match absent pair or absent current controls", () => {
    expect(framePairMatches(undefined, input())).toBe(false);
    expect(framePairMatches(pair(), null)).toBe(false);
  });
});

describe("End-only refinements", () => {
  const revisionId = "00000000-0000-4000-8000-000000000004";
  const nextId = "00000000-0000-4000-8000-000000000005";
  const retained = (): ShotFramePair => ({ ...pair(), startAssetId: "retained-start", startJobId: "paid-start", endAssetId: "original-end", endJobId: "paid-original-end" });

  it("creates only one new request while preserving the Start and original paid pair", () => {
    const original = retained(), before = structuredClone(original), intent = { ...input(), distanceM: 30.5 };
    let calls = 0;
    const revised = newEndRevision(original, intent, "retained-start", () => { calls++; return revisionId; }, new Date("2026-11-15T08:00:00.000Z"));
    expect(calls).toBe(1); expect(original).toEqual(before);
    const { endRevision, ...unchanged } = revised;
    expect(unchanged).toEqual(before);
    expect(endRevision).toMatchObject({ requestId: revisionId, requestedAt: "2026-11-15T08:00:00.000Z", previousJobId: "paid-original-end" });
    expect(savedEndRevisionInput(revised)).toMatchObject({ role: "end", distanceM: 30.5, source: intent.source, continuity: { assetId: "retained-start", atMs: 0 } });
    expect(savedEndRevisionInput(revised)?.guidedPair).toBeUndefined();
    expect(activeEndRequestId(revised)).toBe(revisionId);
    expect(framePairMatches(revised, intent)).toBe(true);
    expect(framePairMatches(revised, input())).toBe(false);
    expect(savedFramePairInput(revised)).toEqual(savedFramePairInput(original));
  });

  it("retains End revision inputs and receipts across save/reopen and Undo/Redo", () => {
    const revised = newEndRevision(retained(), { ...input(), distanceM: 40 }, "retained-start", () => revisionId);
    revised.endRevision = { ...revised.endRevision!, jobId: "revised-job", assetId: "revised-asset" };
    const document = createDocumentStore(cardTimeline());
    document.dispatch({ type: "apply", update: t => insertShotCard(t, "later") });
    document.dispatch({ type: "shot-operation", cardId: "exterior", patch: { framePair: revised } });
    document.dispatch({ type: "undo" });
    expect(shotCards(parseTimeline(JSON.parse(JSON.stringify(document.snapshot().timeline))))[0].framePair).toEqual(revised);
    document.dispatch({ type: "redo" });
    expect(shotCards(document.snapshot().timeline)[0].framePair).toEqual(revised);
  });

  it("requires the same factual reference and retained Start before creating a revision", () => {
    const original = retained();
    expect(() => newEndRevision(original, { ...input(), source: { assetId: "different-house", atMs: 0 } }, "retained-start", () => revisionId)).toThrow();
    expect(() => newEndRevision(original, input(), "different-start", () => revisionId)).toThrow();
    expect(() => newEndRevision({ ...original, startAssetId: undefined }, input(), "retained-start", () => revisionId)).toThrow();
    expect(() => newEndRevision(original, { ...input(), cinematography: undefined }, "retained-start", () => revisionId)).toThrow();
    for (const usedId of [original.id, original.startRequestId, original.endRequestId]) expect(() => newEndRevision(original, input(), "retained-start", () => usedId)).toThrow();
  });

  it("clears only the active revision receipt for another explicit End adjustment", () => {
    const first = newEndRevision(retained(), input(), "retained-start", () => revisionId);
    first.endRevision = { ...first.endRevision!, jobId: "old-revision-job", assetId: "old-revision-asset" };
    const next = newEndRevision(first, { ...input(), distanceM: 50 }, "retained-start", () => nextId);
    expect(next.endRevision).toMatchObject({ requestId: nextId, previousJobId: "old-revision-job" });
    expect(next.endRevision?.jobId).toBeUndefined(); expect(next.endRevision?.assetId).toBeUndefined();
    expect(next.startAssetId).toBe(first.startAssetId); expect(next.endAssetId).toBe("original-end");
    expect(first.endRevision.assetId).toBe("old-revision-asset");
    expect(() => newEndRevision(first, input(), "retained-start", () => revisionId)).toThrow();
    expect(shotFramePairSchema.safeParse({ ...next, endRevision: { ...next.endRevision!, previousJobId: "" } }).success).toBe(false);
  });

  it.each([
    ["broken input", (p: ShotFramePair) => { p.endRevision!.input = "{"; }],
    ["wrong role", (p: ShotFramePair) => { p.endRevision!.input = JSON.stringify({ ...JSON.parse(p.endRevision!.input), role: "start" }); }],
    ["wrong source", (p: ShotFramePair) => { p.endRevision!.input = JSON.stringify({ ...JSON.parse(p.endRevision!.input), source: { assetId: "other", atMs: 0 } }); }],
    ["wrong continuity", (p: ShotFramePair) => { p.endRevision!.input = JSON.stringify({ ...JSON.parse(p.endRevision!.input), continuity: { assetId: "other", atMs: 0 } }); }],
    ["recursive guided pair", (p: ShotFramePair) => { p.endRevision!.input = JSON.stringify({ ...JSON.parse(p.endRevision!.input), guidedPair: { version: 1, id: ids[0], endRequestId: ids[2] } }); }],
    ["missing recipe", (p: ShotFramePair) => { p.endRevision!.input = JSON.stringify({ ...JSON.parse(p.endRevision!.input), cinematography: undefined }); }],
  ] as const)("rejects %s instead of silently falling back to the original End", (_label, corrupt) => {
    const revised = newEndRevision(retained(), input(), "retained-start", () => revisionId); corrupt(revised);
    expect(() => savedEndRevisionInput(revised)).toThrow(); expect(() => activeEndRequestId(revised)).toThrow();
    expect(framePairMatches(revised, input())).toBe(false);
  });

  it("leaves legacy pairs on their original End identity and byte-stable frozen Start", () => {
    const original = pair(), bytes = JSON.stringify(original);
    expect(savedEndRevisionInput(original)).toBeNull(); expect(activeEndRequestId(original)).toBe(original.endRequestId);
    expect(framePairMatches(original, input())).toBe(true); expect(JSON.stringify(original)).toBe(bytes);
  });
});

describe("durable pair receipts", () => {
  it("round-trips all receipts and keeps both generated images plus the factual reference owned", () => {
    const completed = { ...pair(), startJobId: "start-job", endJobId: "end-job", startAssetId: "nano-start", endAssetId: "nano-end" };
    const timeline = updateShotCard(cardTimeline(), "exterior", card => ({ ...card, framePair: completed }));
    const parsed = parseTimeline(JSON.parse(JSON.stringify(timeline)));
    expect(shotCards(parsed)[0].framePair).toEqual(completed);
    expect(new Set(referencedAssetIds(parsed))).toEqual(new Set(["house-reference", "nano-start", "nano-end"]));
    expect(shotFramePairSchema.safeParse({ ...completed, endRequestId: completed.startRequestId }).success).toBe(false);
    expect(shotFramePairSchema.safeParse({ ...completed, requestedAt: "yesterday" }).success).toBe(false);
  });

  it("retains queued and completed pair identities through Undo and Redo without adding edit steps", () => {
    const document = createDocumentStore(cardTimeline());
    document.dispatch({ type: "apply", update: t => insertShotCard(t, "next-shot") });
    const pending = pair();
    document.dispatch({ type: "shot-operation", cardId: "exterior", patch: { framePair: pending } });
    expect(document.getState().history.past).toHaveLength(1);
    document.dispatch({ type: "undo" });
    expect(shotCards(document.snapshot().timeline)[0].framePair).toEqual(pending);
    const completed = { ...pending, startJobId: "saved-start", endJobId: "saved-end", startAssetId: "nano-start", endAssetId: "nano-end" };
    document.dispatch({ type: "shot-operation", cardId: "exterior", patch: { framePair: completed } });
    expect(document.getState().history.past).toHaveLength(0);
    expect(document.getState().history.future).toHaveLength(1);
    document.dispatch({ type: "redo" });
    expect(shotCards(document.snapshot().timeline)[0].framePair).toEqual(completed);
    expect(shotCards(document.snapshot().timeline).map(card => card.id)).toEqual(["exterior", "next-shot"]);
  });

  it("keeps pair receipts with their original source across an undoable reference replacement", () => {
    const document = createDocumentStore(cardTimeline());
    const original = pair();
    document.dispatch({ type: "shot-operation", cardId: "exterior", patch: { framePair: original } });
    document.dispatch({ type: "apply", update: t => updateShotCard(t, "exterior", card => ({ id: card.id, sourceAssetId: "replacement" })) });
    expect(shotCards(document.snapshot().timeline)[0].framePair).toBeUndefined();
    let index = 0;
    const replacement = newFramePair({ ...input(), source: { assetId: "replacement", atMs: 0 } }, () => ids[index++]);
    document.dispatch({ type: "shot-operation", cardId: "exterior", patch: { framePair: replacement } });
    document.dispatch({ type: "undo" });
    expect(shotCards(document.snapshot().timeline)[0]).toMatchObject({ sourceAssetId: "house-reference", framePair: original });
    document.dispatch({ type: "redo" });
    expect(shotCards(document.snapshot().timeline)[0]).toMatchObject({ sourceAssetId: "replacement", framePair: replacement });
  });
});
