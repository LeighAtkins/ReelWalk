import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SHOT_CINEMATOGRAPHY, type CameraKeyframeInput, type ShotFramePair } from "@reelwalk/core";
import { framePairMatches, newFramePair, savedFramePairInput } from "./guided-frame-pair";
import { GuidedFramePairPanel } from "./guided-frame-pair-panel";

const hookState = vi.hoisted(() => ({ index: 0, values: [] as unknown[] }));
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(),
  useState: () => [hookState.values[hookState.index++], vi.fn()], useRef: (value: unknown) => ({ current: value }), useEffect: () => {} }));
vi.mock("./shot-generation-progress", () => ({ ShotGenerationProgress: ({ connectionError }: { connectionError?: string }) => connectionError ?? null }));

it("shows first-load history failure and retries GET only while paid preparation stays disabled", async () => {
  const message = "Your saved requests are retained. Check your connection and refresh status.";
  hookState.index = 0; hookState.values = [{}, undefined, false, 0, false, "", message, undefined, {}, undefined, null];
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ enabled: true, balanceRemaining: 2, jobs: [] }) });
  vi.stubGlobal("fetch", fetch);
  try {
    const tree = GuidedFramePairPanel({ input: null, disabled: false, reviewed: false, onSave: vi.fn(), onReview: vi.fn(), onAssets: vi.fn(), onBalance: vi.fn() });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain(message);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Prepare Start and End/);
    expect(html).toContain("Retry status check");
    let retry: (() => void) | undefined;
    const visit = (node: ReactNode) => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return;
      if (node.type === "button" && node.props.children === "Retry status check") retry = node.props.onClick;
      visit(node.props.children);
    };
    visit(tree); expect(retry).toBeDefined(); retry!();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch.mock.calls[0][0]).toBe("/api/ai/keyframes?");
    expect(fetch.mock.calls[0][1]).not.toHaveProperty("method", "POST");
    expect(fetch.mock.calls[0][0]).not.toContain("recover=1");
  } finally { vi.unstubAllGlobals(); }
});

const file = ts.createSourceFile("panel.tsx", readFileSync(new URL("./guided-frame-pair-panel.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let body = "";
let anotherPairCondition = "";
const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && ["prepare", "review", "post"].includes(node.name?.text ?? "")) body += node.getText(file) + "\n"; ts.forEachChild(node, visit); }; visit(file);
const findAnotherPair = (node: ts.Node) => { if (ts.isConditionalExpression(node) && node.whenTrue.getText(file).includes(">Prepare another pair")) anotherPairCondition = node.condition.getText(file); ts.forEachChild(node, findAnotherPair); }; findAnotherPair(file);
const code = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const input: CameraKeyframeInput = { role: "start", source: { assetId: "original-house", atMs: 0 }, move: "rise", distanceM: 3, durationSeconds: 4, cinematography: DEFAULT_SHOT_CINEMATOGRAPHY };
function fixture(pair?: ShotFramePair) {
  const current = { current: { pair, input } };
  return { pair, input, current, disabled: false, historyReady: true, admission: { enabled: true, balanceRemaining: 10 },
    jobs: {} as Record<string, { id: string; status: string; continuationError?: string }>, lock: { current: false }, live: { current: true }, busy: false,
    matches: true, bothReady: true, previewsReady: true, setBusy: vi.fn(), setError: vi.fn(), beforePrepare: vi.fn().mockResolvedValue(true),
    onSave: vi.fn(async (saved: ShotFramePair) => { current.current.pair = saved; return true; }),
    fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ job: { id: "retained-start" } }) }),
    refresh: vi.fn().mockResolvedValue({}), onAssets: vi.fn(), onReview: vi.fn(), framePairMatches, newFramePair, savedFramePairInput,
    active: (job?: { status: string }) => !!job && ["QUEUED", "SUBMITTING", "UNKNOWN"].includes(job.status),
    finished: (job?: { status: string }) => !!job && ["CANDIDATE", "USED"].includes(job.status) };
}
const run = (env: ReturnType<typeof fixture>, action = "prepare", retry = false) => new Function(...Object.keys(env), `${code};return ${action};`)(...Object.values(env))(retry);
const offersAnotherPair = (env: ReturnType<typeof fixture>) => new Function(...Object.keys(env), `return Boolean(${anotherPairCondition});`)(...Object.values(env));

it("reports a missing End distinctly only after history and Start are confirmed", () => {
  let statusCode = "";
  const collect = (node: ts.Node) => { if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ["waitingForEnd", "status"].includes(d.name.getText(file)))) statusCode += node.getText(file) + "\n"; ts.forEachChild(node, collect); }; collect(file);
  const evaluate = (historyReady: boolean, start: { status: string }, end?: { status: string }) => new Function("historyReady", "jobs", "finished", "bothReady", "currentJob", "busy", "pair", `${statusCode};return { status, waitingForEnd };`)(historyReady, { start, end }, (job?: { status: string }) => !!job && ["CANDIDATE", "USED"].includes(job.status), false, end, false, {});
  expect(evaluate(true, { status: "CANDIDATE" })).toEqual({ status: "WAITING_END", waitingForEnd: true });
  expect(evaluate(false, { status: "CANDIDATE" }).status).toBe("CHECKING");
  expect(evaluate(true, { status: "UNKNOWN" }).status).toBe("CHECKING");
  for (const status of ["QUEUED", "SUBMITTING", "UNKNOWN", "FAILED"]) expect(evaluate(true, { status: "USED" }, { status }).status).toBe(status);
});

it("offers a new pair for changed settings after a retained Start and paused End admission", async () => {
  const pair = newFramePair(input), original = JSON.stringify(pair), env = fixture(pair);
  env.input = { ...input, distanceM: 4 }; env.matches = false; env.bothReady = false;
  env.jobs = { start: { id: "retained-start", status: "USED", continuationError: "End preparation paused: credits unavailable" } };
  expect(offersAnotherPair(env)).toBe(true);
  await run(env);
  const saved = env.onSave.mock.calls[0][0];
  expect(saved.id).not.toBe(pair.id); expect(saved.startRequestId).not.toBe(pair.startRequestId); expect(saved.endRequestId).not.toBe(pair.endRequestId);
  expect(JSON.parse(env.fetch.mock.calls[0][1].body)).toMatchObject({ action: "generate", role: "start", requestId: saved.startRequestId, distanceM: 4 });
  expect(JSON.stringify(pair)).toBe(original);
});
it.each(["QUEUED", "SUBMITTING", "UNKNOWN"])("never offers or submits a new pair when Start is %s", async status => {
  const env = fixture(newFramePair(input)); env.matches = false; env.bothReady = false;
  env.jobs = { start: { id: "retained-start", status, continuationError: "Old pause message" } };
  expect(offersAnotherPair(env)).toBe(false); await run(env); expect(env.fetch).not.toHaveBeenCalled(); expect(env.onSave).not.toHaveBeenCalled();
});
it("does not offer this recovery before reconciliation or without confirmed paused End admission", () => {
  const env = fixture(newFramePair(input)); env.matches = false; env.bothReady = false;
  env.jobs = { start: { id: "retained-start", status: "USED" } };
  expect(offersAnotherPair(env)).toBe(false);
  env.jobs.start.continuationError = "End preparation paused"; env.historyReady = false;
  expect(offersAnotherPair(env)).toBe(false);
});
it("retains the UNKNOWN End guard and the existing two-credit admission check", async () => {
  const env = fixture(newFramePair(input)); env.matches = false; env.bothReady = false;
  env.jobs = { start: { id: "start", status: "USED", continuationError: "End preparation paused" }, end: { id: "end", status: "UNKNOWN" } };
  expect(offersAnotherPair(env)).toBe(false); await run(env); expect(env.fetch).not.toHaveBeenCalled();
  delete env.jobs.end; env.admission.balanceRemaining = 1;
  await run(env); expect(env.onSave).not.toHaveBeenCalled(); expect(env.fetch).not.toHaveBeenCalled();
});

it("saves both request identities and frozen inputs before the first generation POST", async () => {
  const env = fixture(); await run(env);
  expect(env.onSave).toHaveBeenCalledOnce(); expect(env.fetch).toHaveBeenCalledOnce();
  expect(env.onSave.mock.invocationCallOrder[0]).toBeLessThan(env.fetch.mock.invocationCallOrder[0]);
  const saved = env.onSave.mock.calls[0][0], sent = JSON.parse(env.fetch.mock.calls[0][1].body);
  expect(sent.requestId).toBe(saved.startRequestId); expect(sent.guidedPair.endRequestId).toBe(saved.endRequestId);
  expect(saved.startRequestId).not.toBe(saved.endRequestId); expect(sent.source.assetId).toBe("original-house");
});
it("does not spend when a card cannot save or history cannot be checked", async () => {
  const env = fixture(); env.onSave.mockResolvedValue(false); await run(env); expect(env.fetch).not.toHaveBeenCalled();
  const pending = fixture(); pending.historyReady = false; await run(pending); expect(pending.onSave).not.toHaveBeenCalled(); expect(pending.fetch).not.toHaveBeenCalled();
});
it("recovers a lost initial response with the same exact request, including its End identity", async () => {
  const first = fixture(); first.fetch.mockRejectedValue(Error("lost response")); await run(first);
  const pair = first.onSave.mock.calls[0][0]; const next = fixture(pair); await run(next, "prepare", true);
  expect(next.fetch.mock.calls[0][1].body).toBe(first.fetch.mock.calls[0][1].body);
  expect(next.onSave.mock.calls[0][0]).toEqual(pair);
});
it.each(["QUEUED", "SUBMITTING", "UNKNOWN"])("does not resubmit an existing %s Start", async status => {
  const env = fixture(newFramePair(input)); env.refresh.mockResolvedValue({ start: { id: "existing", status } }); await run(env, "prepare", true);
  expect(env.fetch).not.toHaveBeenCalled();
});
it("reconciles an existing End before considering a continuation", async () => {
  const env = fixture(newFramePair(input)); env.refresh.mockResolvedValue({ end: { id: "end", status: "UNKNOWN" } }); await run(env, "prepare", true); expect(env.fetch).not.toHaveBeenCalled();
});
it("continues only the retained Start and never creates a second pair identity", async () => {
  const pair = newFramePair(input), env = fixture(pair); env.refresh.mockResolvedValue({ start: { id: "saved-start", status: "USED" } });
  await run(env, "prepare", true); expect(JSON.parse(env.fetch.mock.calls[0][1].body)).toEqual({ action: "continue-pair", jobId: "saved-start" });
  expect(env.onSave.mock.calls[0][0]).toEqual(pair);
});
it("refuses continuation after changed settings or an uncertain history read", async () => {
  const env = fixture(newFramePair(input)); env.input = { ...input, distanceM: 4 }; await run(env, "prepare", true); expect(env.fetch).not.toHaveBeenCalled();
  const unknown = fixture(newFramePair(input)); unknown.refresh.mockResolvedValue(undefined); await run(unknown, "prepare", true); expect(unknown.fetch).not.toHaveBeenCalled();
});
it("never imports a pair whose previews could not be viewed", async () => {
  const env = fixture(newFramePair(input)); env.previewsReady = false; await run(env, "review"); expect(env.fetch).not.toHaveBeenCalled(); expect(env.onReview).not.toHaveBeenCalled();
});
it("keeps returned assets but cannot approve an edited pair while imports are in flight", async () => {
  const pair = newFramePair(input), env = fixture(pair); env.jobs = { start: { id: "start", status: "CANDIDATE" }, end: { id: "end", status: "CANDIDATE" } };
  env.fetch.mockImplementation(async () => { env.current.current.input = { ...input, distanceM: 5 }; return { ok: true, json: async () => ({ asset: { id: "retained" } }) }; });
  await run(env, "review"); expect(env.fetch).toHaveBeenCalledTimes(2); expect(env.onReview).not.toHaveBeenCalled(); expect(env.onSave).not.toHaveBeenCalled();
});
