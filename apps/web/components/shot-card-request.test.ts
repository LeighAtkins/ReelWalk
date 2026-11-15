import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { aiShotSchema, emptyTimeline, insertShotCard, shotCards, updateShotCard } from "@reelwalk/core";
import { createDocumentStore } from "./editor/document-store";
const source = ts.createSourceFile("panel.tsx", readFileSync(new URL("./ai-video-panel.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let body = "";
const find = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === "generate") body = node.getText(source); ts.forEachChild(node, find); }; find(source);
const code = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const fixture = () => ({ busy: false, card: { id: "reserved", draft: "approved", request: undefined as unknown }, setError: vi.fn(), setBusy: vi.fn(),
  useEndReference: false, bridge: false, startImageBlocked: false, endImageBlocked: false, aiShotSchema, mode: "custom", move: "", direction: "push-in",
  firstFrame: { assetId: "start", atMs: 0 }, lastFrame: { assetId: "end", atMs: 0 }, anchor: undefined, style: "source", atmosphere: "source", energy: "subtle",
  onAdd: vi.fn(), harmonize: false, polish: false, next: undefined, draft: false, reelId: "reel", clips: [], beforeGenerate: vi.fn().mockResolvedValue(true),
  currentPrompt: "A gentle camera move through the property", seconds: 4, draftMode: false, requestSignature: { current: "" }, requestId: { current: null },
  crypto: { randomUUID: () => "saved-request" }, onCardRequest: vi.fn().mockResolvedValue(false), fetch: vi.fn(), refresh: vi.fn() });
const run = async (env: ReturnType<typeof fixture>) => new Function(...Object.keys(env), `${code};return generate;`)(...Object.values(env))({ preventDefault() {} });
it("does not submit video when its durable request cannot save", async () => {
  const env = fixture(); await run(env);
  expect(env.onCardRequest).toHaveBeenCalledWith({ id: "saved-request", draft: "approved" });
  expect(env.fetch).not.toHaveBeenCalled(); expect(env.setError).toHaveBeenCalledWith("Save this card and its request before generating.");
});
it("does not resubmit a retained failed or unknown request on generate", async () => {
  const env = fixture(); env.card.request = { id: "unknown" }; await run(env);
  expect(env.fetch).not.toHaveBeenCalled(); expect(env.beforeGenerate).not.toHaveBeenCalled(); expect(env.onCardRequest).not.toHaveBeenCalled();
});

it("recovers the same ambiguous submitted video after undo and reopen without another POST", async () => {
  const prepared = updateShotCard(insertShotCard(emptyTimeline(), "reserved"), "reserved", card => ({ ...card, sourceAssetId: "house", draft: "approved" }));
  const document = createDocumentStore(prepared);
  document.dispatch({ type: "apply", update: t => insertShotCard(t, "neighbour") });
  const env = fixture();
  env.onCardRequest.mockImplementation(async request => {
    document.dispatch({ type: "shot-operation", cardId: "reserved", patch: { request } });
    return true;
  });
  env.fetch.mockRejectedValue(Error("connection lost after submission"));
  await run(env);
  expect(env.fetch).toHaveBeenCalledOnce();
  document.dispatch({ type: "undo" });
  const reopened = shotCards(document.snapshot().timeline).find(card => card.id === "reserved")!;
  expect(reopened.request).toEqual({ id: "saved-request", draft: "approved" });
  const retry = fixture(); retry.card = { ...retry.card, ...reopened };
  await run(retry);
  expect(retry.fetch).not.toHaveBeenCalled();
  expect(retry.onCardRequest).not.toHaveBeenCalled();
  document.dispatch({ type: "redo" });
  expect(shotCards(document.snapshot().timeline)[0].request?.id).toBe("saved-request");
});
