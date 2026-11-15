import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { emptyTimeline, insertShotCard, shotCards, updateShotCard } from "@reelwalk/core";
import { createDocumentStore } from "./document-store";
const source = ts.createSourceFile("autosave.ts", readFileSync(new URL("./use-autosave.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
let body = "";
const find = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(source) === "flush" && node.initializer && ts.isCallExpression(node.initializer)) body = node.initializer.arguments[0].getText(source); ts.forEachChild(node, find); }; find(source);
const code = ts.transpileModule(`const flush = ${body};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
it.each([true, false])("flushes the dispatched request snapshot before React effects, respecting save success=%s", async ok => {
  const old = { timeline: emptyTimeline(), title: "Property" }, current = insertShotCard(old.timeline, "request-card");
  const fetch = vi.fn().mockResolvedValue(Response.json(ok ? { ok: true, revision: 6 } : { ok: false, reason: "conflict", message: "Reload" }));
  const env = { latest: { current: old }, saved: { current: old }, inFlight: { current: null }, blocked: { current: false }, revision: { current: 5 }, timer: { current: undefined },
    setStatus: vi.fn(), setMessage: vi.fn(), fetch, reelId: "reel", clearTimeout: vi.fn(), setTimeout: vi.fn(), flushRef: { current: vi.fn() } };
  const flush = new Function(...Object.keys(env), `${code};return flush;`)(...Object.values(env));
  expect(await flush(current)).toBe(ok);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ revision: 5, timeline: current, title: "Property" });
  expect(env.blocked.current).toBe(!ok);
  expect(env.setTimeout).not.toHaveBeenCalled();
});

it("keeps cards in the existing document undo/redo history", async () => {
  const { createDocumentStore } = await import("./document-store");
  const { moveShotCard, removeShotCard, shotCards } = await import("@reelwalk/core");
  const document = createDocumentStore(emptyTimeline());
  document.dispatch({ type: "apply", update: t => insertShotCard(insertShotCard(t, "first"), "second") });
  document.dispatch({ type: "apply", update: t => moveShotCard(t, "second", -1) });
  document.dispatch({ type: "apply", update: t => removeShotCard(t, "first") });
  document.dispatch({ type: "undo" });
  expect(shotCards(document.snapshot().timeline).map(c => c.id)).toEqual(["second", "first"]);
  document.dispatch({ type: "undo" });
  expect(shotCards(document.snapshot().timeline).map(c => c.id)).toEqual(["first", "second"]);
  document.dispatch({ type: "redo" });
  expect(shotCards(document.snapshot().timeline).map(c => c.id)).toEqual(["second", "first"]);
});

it("retains image requests and accepted choices across undo/redo without adding undo steps", () => {
  const initial = updateShotCard(insertShotCard(emptyTimeline(), "room"), "room", card => ({ ...card, sourceAssetId: "original" }));
  const document = createDocumentStore(initial);
  document.dispatch({ type: "apply", update: t => insertShotCard(t, "neighbour") });
  const requestKey = "shot-keyframe-request:room:end", choiceKey = "shot-keyframe-choice:room:end";
  const pending = JSON.stringify({ requestId: "same-image-request", inputKey: "original-controls" });
  document.dispatch({ type: "shot-operation", cardId: "room", patch: { recovery: { [requestKey]: pending } } });
  expect(document.getState().history.past).toHaveLength(1);
  document.dispatch({ type: "undo" });
  expect(shotCards(document.snapshot().timeline)[0].recovery?.[requestKey]).toBe(pending);
  const choice = { [requestKey]: "", [choiceKey]: JSON.stringify({ id: "paid-image-job" }) };
  document.dispatch({ type: "shot-operation", cardId: "room", patch: { recovery: choice } });
  document.dispatch({ type: "redo" });
  expect(shotCards(document.snapshot().timeline)[0].recovery).toEqual(choice);
  expect(document.getState().history.future).toHaveLength(0);
});

it("keeps operational identities scoped to the original source while source replacement stays undoable", () => {
  const initial = updateShotCard(insertShotCard(emptyTimeline(), "room"), "room", card => ({ ...card, sourceAssetId: "original" }));
  const document = createDocumentStore(initial);
  const original = { id: "original-request", draft: "original-draft" };
  document.dispatch({ type: "shot-operation", cardId: "room", patch: { request: original } });
  document.dispatch({ type: "apply", update: t => updateShotCard(t, "room", card => ({ id: card.id, sourceAssetId: "replacement" })) });
  expect(shotCards(document.snapshot().timeline)[0].request).toBeUndefined();
  const replacement = { id: "replacement-request", draft: "replacement-draft" };
  document.dispatch({ type: "shot-operation", cardId: "room", patch: { request: replacement } });
  document.dispatch({ type: "undo" });
  expect(shotCards(document.snapshot().timeline)[0]).toMatchObject({ sourceAssetId: "original", request: original });
  document.dispatch({ type: "redo" });
  expect(shotCards(document.snapshot().timeline)[0]).toMatchObject({ sourceAssetId: "replacement", request: replacement });
});
