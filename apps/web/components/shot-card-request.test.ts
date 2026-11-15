import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { aiShotSchema, emptyTimeline, insertShotCard, shotCards, updateShotCard } from "@reelwalk/core";
import { createDocumentStore } from "./editor/document-store";
import { shotCardPayloadSchema } from "./shot-card-request";
const source = ts.createSourceFile("panel.tsx", readFileSync(new URL("./ai-video-panel.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let body = "";
const find = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && ["videoPayload", "submitVideo", "generate", "retrySavedRequest"].includes(node.name?.text ?? "")) body += node.getText(source) + "\n"; ts.forEachChild(node, find); }; find(source);
const code = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const fixture = () => ({ busy: false, card: { id: "reserved", draft: "approved", request: undefined as unknown }, setError: vi.fn(), setBusy: vi.fn(),
  useEndReference: false, bridge: false, startImageBlocked: false, endImageBlocked: false, aiShotSchema, shotCardPayloadSchema, mode: "custom", move: "", direction: "push-in",
  firstFrame: { assetId: "start", atMs: 0 }, lastFrame: { assetId: "end", atMs: 0 }, anchor: undefined, style: "source", atmosphere: "source", energy: "subtle",
  onAdd: vi.fn(), harmonize: false, polish: false, next: undefined, draft: false, reelId: "reel", clips: [], beforeGenerate: vi.fn().mockResolvedValue(true),
  currentPrompt: "A gentle camera move through the property", seconds: 4, draftMode: false, requestSignature: { current: "" }, requestId: { current: null },
  crypto: { randomUUID: vi.fn(() => "saved-request") }, onCardRequest: vi.fn().mockResolvedValue(false), fetch: vi.fn(), refresh: vi.fn().mockResolvedValue({ jobs: [] }) });
const run = async (env: ReturnType<typeof fixture>, action = "generate") => new Function(...Object.keys(env), `${code};return ${action};`)(...Object.values(env))({ preventDefault() {} });
it("does not submit video when its durable request cannot save", async () => {
  const env = fixture(); await run(env);
  expect(env.onCardRequest).toHaveBeenCalledWith({ id: "saved-request", draft: "approved", payload: expect.any(String) });
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
  expect(reopened.request).toEqual({ id: "saved-request", draft: "approved", payload: expect.any(String) });
  const retry = fixture(); retry.card = { ...retry.card, ...reopened };
  await run(retry);
  expect(retry.fetch).not.toHaveBeenCalled();
  expect(retry.onCardRequest).not.toHaveBeenCalled();
  document.dispatch({ type: "redo" });
  expect(shotCards(document.snapshot().timeline)[0].request?.id).toBe("saved-request");
});

async function rejectedRequest() {
  const env = fixture();
  env.onCardRequest.mockResolvedValue(true);
  env.fetch.mockResolvedValue({ ok: false, json: async () => ({ error: "The take queue is full" }) });
  await run(env);
  return { env, saved: env.onCardRequest.mock.calls[0][0], body: env.fetch.mock.calls[0][1].body };
}

it("retries a queue rejection after reload with the exact saved request and ID", async () => {
  const { saved, body } = await rejectedRequest();
  const env = fixture(); env.card.request = JSON.parse(JSON.stringify(saved));
  env.onCardRequest.mockResolvedValue(true);
  env.fetch.mockResolvedValue({ ok: true, json: async () => ({ id: "accepted-job" }) });
  await run(env, "retrySavedRequest");
  expect(env.refresh).toHaveBeenCalledTimes(2);
  expect(env.fetch).toHaveBeenCalledOnce();
  expect(env.fetch.mock.calls[0][1].body).toBe(body);
  expect(env.crypto.randomUUID).not.toHaveBeenCalled();
  expect(env.onCardRequest).toHaveBeenLastCalledWith({ ...saved, jobId: "accepted-job" });
});

it("collects an accepted request before retry without another POST", async () => {
  const { saved } = await rejectedRequest();
  const env = fixture(); env.card.request = saved;
  env.refresh.mockResolvedValue({ jobs: [{ id: "accepted-job", requestId: saved.id }] });
  await run(env, "retrySavedRequest");
  expect(env.fetch).not.toHaveBeenCalled(); expect(env.crypto.randomUUID).not.toHaveBeenCalled();
});

it.each(["prompt", "boundary", "draft"])("refuses to retry when the current %s changed", async change => {
  const { saved } = await rejectedRequest();
  const env = fixture(); env.card.request = saved;
  if (change === "prompt") env.currentPrompt = "A different move than the saved request";
  if (change === "boundary") env.firstFrame = { assetId: "start", atMs: 1000 };
  if (change === "draft") env.card.draft = "changed";
  await run(env, "retrySavedRequest");
  expect(env.fetch).not.toHaveBeenCalled(); expect(env.onCardRequest).not.toHaveBeenCalled();
  expect(env.setError).toHaveBeenCalledWith("Restore the saved shot's frames and settings before retrying its request.");
});

it("cannot retry when the durable save fails or the lookup is uncertain", async () => {
  const { saved } = await rejectedRequest();
  const env = fixture(); env.card.request = saved;
  await run(env, "retrySavedRequest");
  expect(env.fetch).not.toHaveBeenCalled();
  expect(env.setError).toHaveBeenCalledWith("Save this card and its request before generating.");
  env.refresh.mockRejectedValue(Error("Status unavailable")); env.onCardRequest.mockClear();
  await run(env, "retrySavedRequest");
  expect(env.fetch).not.toHaveBeenCalled(); expect(env.onCardRequest).not.toHaveBeenCalled();
});

it("retains older requests without frozen inputs and known jobs missing from a response", async () => {
  for (const request of [{ id: "old", draft: "approved" }, { ...(await rejectedRequest()).saved, jobId: "known" }]) {
    const env = fixture(); env.card.request = request;
    await run(env, "retrySavedRequest"); expect(env.fetch).not.toHaveBeenCalled();
  }
});

it("validates the full prompt before reserving a card identity", async () => {
  const env = fixture(); env.currentPrompt = "x".repeat(2001);
  await run(env); expect(env.onCardRequest).not.toHaveBeenCalled(); expect(env.fetch).not.toHaveBeenCalled();
});
