import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { DEFAULT_SHOT_CINEMATOGRAPHY, emptyTimeline, insertShotCard, shotCards, updateShotCard, type CameraKeyframeInput, type ShotCard, type ShotFramePair } from "@reelwalk/core";
import { activeEndRequestId, newEndRevision, newFramePair } from "../guided-frame-pair";
import { createDocumentStore } from "./document-store";

const file = ts.createSourceFile("editor.tsx", readFileSync(new URL("./editor.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "canSaveCardFramePair")!;
const code = ts.transpileModule(declaration.getText(file).replace(/^export /, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const accepts = new Function("activeEndRequestId", `${code};return canSaveCardFramePair;`)(activeEndRequestId) as (card: ShotCard, pair: ShotFramePair, expectedId?: string, expectedEnd?: string) => boolean;
const input: CameraKeyframeInput = { role: "start", source: { assetId: "source", atMs: 0 }, move: "rise", distanceM: 3, durationSeconds: 4, cinematography: DEFAULT_SHOT_CINEMATOGRAPHY };
const original = (): ShotFramePair => ({ ...newFramePair(input), startAssetId: "start-image", endAssetId: "original-end", endJobId: "original-end-job" });
const card = (framePair: ShotFramePair): ShotCard => ({ id: "property", sourceAssetId: "source", framePair });

it("rejects old End receipts after a new revision, including callbacks that omit its revision token", () => {
  const previous = original(), next = newEndRevision(previous, { ...input, distanceM: 30 }, "start-image");
  expect(accepts(card(previous), next, previous.id, activeEndRequestId(previous))).toBe(true);
  expect(accepts(card(next), previous, previous.id, activeEndRequestId(previous))).toBe(false);
  expect(accepts(card(next), previous, previous.id)).toBe(false);
  expect(accepts(card(next), { ...next, endRevision: { ...next.endRevision!, jobId: "saved-end-job" } }, next.id, activeEndRequestId(next))).toBe(true);
});
it("rejects mutation of frozen revision inputs or Start while accepting its result receipt", () => {
  const next = newEndRevision(original(), { ...input, distanceM: 30 }, "start-image");
  const token = activeEndRequestId(next);
  expect(accepts(card(next), { ...next, endRevision: { ...next.endRevision!, requestedAt: "2026-11-15T00:00:00.000Z" } }, next.id, token)).toBe(false);
  expect(accepts(card(next), { ...next, endRevision: { ...next.endRevision!, input: JSON.stringify({ ...JSON.parse(next.endRevision!.input), distanceM: 40 }) } }, next.id, token)).toBe(false);
  expect(accepts(card(next), { ...next, startAssetId: "other-start" }, next.id, token)).toBe(false);
});
it("retains the active revision request and result through Undo and Redo", () => {
  const previous = original(), next = newEndRevision(previous, { ...input, distanceM: 30 }, "start-image");
  const initial = updateShotCard(insertShotCard(emptyTimeline(), "property"), "property", () => card(previous));
  const document = createDocumentStore(initial);
  document.dispatch({ type: "apply", update: timeline => insertShotCard(timeline, "second") });
  document.dispatch({ type: "shot-operation", cardId: "property", patch: { framePair: next } });
  document.dispatch({ type: "undo" });
  expect(shotCards(document.snapshot().timeline)[0].framePair?.endRevision?.requestId).toBe(next.endRevision?.requestId);
  const done = { ...next, endRevision: { ...next.endRevision!, assetId: "retained-new-end" } };
  document.dispatch({ type: "shot-operation", cardId: "property", patch: { framePair: done } });
  document.dispatch({ type: "redo" });
  expect(shotCards(document.snapshot().timeline)[0].framePair?.endRevision).toEqual(done.endRevision);
});
