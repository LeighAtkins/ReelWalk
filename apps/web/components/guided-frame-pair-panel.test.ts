import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SHOT_CINEMATOGRAPHY, type CameraKeyframeInput, type ShotFramePair } from "@reelwalk/core";
import { activeEndRequestId, framePairIntent, framePairMatches, newEndRevision, newFramePair, savedEndRevisionInput, savedFramePairInput } from "./guided-frame-pair";
import { canReviseEnd, frameCardLabel, framePairReceipt, sameFrameOperation, GuidedFramePairPanel } from "./guided-frame-pair-panel";

const hookState = vi.hoisted(() => ({ index: 0, values: [] as unknown[] }));
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(),
  useState: () => [hookState.values[hookState.index++], vi.fn()], useRef: (value: unknown) => ({ current: value }), useEffect: () => {} }));

it("shows first-load history failure and retries GET only while paid preparation stays disabled", async () => {
  const message = "Your saved requests are retained. Check your connection and refresh status.";
  hookState.index = 0; hookState.values = [{}, undefined, false, 0, false, "", message, {}, undefined, null, false];
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
const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && ["prepare", "review", "post", "refineEnd", "keepStart"].includes(node.name?.text ?? "")) body += node.getText(file) + "\n"; ts.forEachChild(node, visit); }; visit(file);
const findAnotherPair = (node: ts.Node) => { if (ts.isConditionalExpression(node) && node.whenTrue.getText(file).includes(">Prepare another pair")) anotherPairCondition = node.condition.getText(file); ts.forEachChild(node, findAnotherPair); }; findAnotherPair(file);
const code = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const input: CameraKeyframeInput = { role: "start", source: { assetId: "original-house", atMs: 0 }, move: "rise", distanceM: 3, durationSeconds: 4, cinematography: DEFAULT_SHOT_CINEMATOGRAPHY };
function fixture(pair?: ShotFramePair) {
  const current = { current: { pair, input } };
  return { pair, input, current, disabled: false, inputValid: true, historyReady: true, admission: { enabled: true, balanceRemaining: 10 },
    jobs: {} as Record<string, { id: string; status: string; continuationError?: string; asset?: { id: string }; candidateUrl?: string }>, lock: { current: false }, live: { current: true }, busy: false,
    matches: true, bothReady: true, previewsReady: true, manualReview: "reviewed", reviewKey: "reviewed", loaded: { start: true, source: true }, imageKeys: { start: "start" }, sourceKey: "source", onUseStart: vi.fn(), setBusy: vi.fn(), setError: vi.fn(), beforePrepare: vi.fn().mockResolvedValue(true),
    onSave: vi.fn(async (saved: ShotFramePair) => { current.current.pair = saved; return true; }),
    fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ job: { id: "retained-start" } }) }),
    refresh: vi.fn().mockResolvedValue({}), onAssets: vi.fn(), onReview: vi.fn(), setEndEditing: vi.fn(), framePairMatches, newFramePair, savedFramePairInput,
    activeEndRequestId, framePairIntent, savedEndRevisionInput, sameFrameOperation, canReviseEnd, newEndRevision,
    active: (job?: { status: string }) => !!job && ["QUEUED", "SUBMITTING", "UNKNOWN"].includes(job.status),
    finished: (job?: { status: string }) => !!job && ["CANDIDATE", "USED"].includes(job.status) };
}
const run = (env: ReturnType<typeof fixture>, action = "prepare", retry = false) => new Function(...Object.keys(env), `${code};return ${action};`)(...Object.values(env))(retry);
const offersAnotherPair = (env: ReturnType<typeof fixture>) => new Function(...Object.keys(env), `return Boolean(${anotherPairCondition});`)(...Object.values(env));

it("labels waiting, queued, creating and uncertain images separately on their cards", () => {
  const job = (status: string) => ({ status }) as Parameters<typeof frameCardLabel>[0];
  expect(frameCardLabel(undefined)).toBe("Not started");
  expect(frameCardLabel(undefined, true)).toBe("Waiting for Start");
  expect(frameCardLabel(job("QUEUED"))).toBe("Queued");
  expect(frameCardLabel(job("SUBMITTING"))).toBe("Creating image");
  expect(frameCardLabel(job("UNKNOWN"))).toBe("Checking saved result");
  expect(frameCardLabel(job("CANDIDATE"))).toBe("Ready");
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

function readyPair() {
  const pair = { ...newFramePair(input), startAssetId: "retained-start", startJobId: "start-job", endJobId: "original-end", endAssetId: "retained-end" };
  const env = fixture(pair);
  env.input = { ...input, distanceM: 30 }; env.current.current.input = env.input;
  env.jobs = { start: { id: "start-job", status: "USED", asset: { id: "retained-start" } }, end: { id: "original-end", status: "CANDIDATE", candidateUrl: "/original-end" } };
  env.refresh.mockResolvedValue({ ...env.jobs, pair });
  return env;
}

it("End-only refinement persists one new identity before one End POST, keeping original pair and Start", async () => {
  const env = readyPair(), original = JSON.stringify(env.pair);
  await run(env, "refineEnd");
  expect(env.onSave).toHaveBeenCalledOnce(); expect(env.fetch).toHaveBeenCalledOnce();
  expect(env.onSave.mock.invocationCallOrder[0]).toBeLessThan(env.fetch.mock.invocationCallOrder[0]);
  const saved = env.onSave.mock.calls[0][0], sent = JSON.parse(env.fetch.mock.calls[0][1].body);
  expect(saved.startRequestId).toBe(env.pair!.startRequestId); expect(saved.endRequestId).toBe(env.pair!.endRequestId);
  expect(saved.startAssetId).toBe("retained-start"); expect(saved.endRevision!.previousJobId).toBe("original-end");
  expect(sent).toMatchObject({ action: "generate", role: "end", distanceM: 30, continuity: { assetId: "retained-start" }, requestId: saved.endRevision!.requestId });
  expect(sent).not.toHaveProperty("guidedPair"); expect(JSON.stringify(env.pair)).toBe(original);
});
it.each(["QUEUED", "SUBMITTING", "UNKNOWN"])("never replaces an active or ambiguous %s End", async status => {
  const env = readyPair(); env.jobs.end.status = status;
  await run(env, "refineEnd"); expect(env.fetch).not.toHaveBeenCalled(); expect(env.onSave).not.toHaveBeenCalled();
});
it("reconciles End before spending and rejects a newly discovered UNKNOWN outcome", async () => {
  const env = readyPair(); env.refresh.mockResolvedValue({ ...env.jobs, end: { id: "existing", status: "UNKNOWN" } });
  await run(env, "refineEnd"); expect(env.fetch).not.toHaveBeenCalled(); expect(env.onSave).not.toHaveBeenCalled();
});
it("does not race an original automatic End handoff merely because it has not appeared yet", () => {
  const env = readyPair(), start = env.jobs.start as Parameters<typeof canReviseEnd>[2];
  expect(canReviseEnd(env.pair, true, start)).toBe(false);
  env.jobs.start.continuationError = "End admission paused";
  expect(canReviseEnd(env.pair, true, start)).toBe(true);
  expect(canReviseEnd(env.pair, false, start)).toBe(false);
});
it("resumes a lost End-only POST using the exact saved End identity and no Start POST", async () => {
  const first = readyPair(); first.fetch.mockRejectedValue(Error("response lost")); await run(first, "refineEnd");
  const saved = first.onSave.mock.calls[0][0], next = fixture(saved); next.input = first.input; next.current.current.input = next.input;
  next.refresh.mockResolvedValue({ start: first.jobs.start });
  await run(next, "prepare", true);
  expect(next.fetch).toHaveBeenCalledOnce(); expect(next.fetch.mock.calls[0][1].body).toBe(first.fetch.mock.calls[0][1].body);
});
it("recovers the frozen End request after unsent controls change without submitting their new intent", async () => {
  const first = readyPair(); first.fetch.mockRejectedValue(Error("response lost")); await run(first, "refineEnd");
  const saved = first.onSave.mock.calls[0][0], next = fixture(saved);
  next.input = { ...input, distanceM: 60 }; next.current.current.input = next.input;
  next.refresh.mockResolvedValue({ start: first.jobs.start });
  await run(next, "prepare", true);
  expect(next.fetch).toHaveBeenCalledOnce(); expect(next.fetch.mock.calls[0][1].body).toBe(first.fetch.mock.calls[0][1].body);
  expect(JSON.parse(next.fetch.mock.calls[0][1].body).distanceM).toBe(30);
});
it("prevents an old poll or review from owning a newer End under the same pair ID", async () => {
  const env = readyPair(), revised = newEndRevision(env.pair!, env.input, "retained-start");
  expect(sameFrameOperation(env.pair, revised)).toBe(false);
  const nextEnd = { id: "revised-job", asset: { id: "revised-asset" } } as Parameters<typeof framePairReceipt>[2];
  const receipt = framePairReceipt(revised, undefined, nextEnd);
  expect(receipt.endJobId).toBe("original-end"); expect(receipt.endAssetId).toBe("retained-end");
  expect(receipt.endRevision).toMatchObject({ jobId: "revised-job", assetId: "revised-asset" });
  env.input = input; env.current.current.input = input;
  env.fetch.mockImplementation(async () => { env.current.current.pair = revised; return { ok: true, json: async () => ({ asset: { id: "old-asset" } }) }; });
  await run(env, "review"); expect(env.onReview).not.toHaveBeenCalled(); expect(env.onSave).not.toHaveBeenCalled();
});
it("invalid distance blocks both first-pair and End-only spending", async () => {
  const env = readyPair(); env.inputValid = false;
  await run(env, "refineEnd"); await run(env);
  expect(env.fetch).not.toHaveBeenCalled(); expect(env.onSave).not.toHaveBeenCalled();
});
it("shows per-image indeterminate loading without invented percentages or a sticky status portal", () => {
  const env = readyPair();
  hookState.index = 0; hookState.values = [{ ...env.jobs, end: { id: "pending", status: "SUBMITTING" } }, { enabled: true, balanceRemaining: 2 }, true, 0, false, "", null, {}, undefined, null, false];
  const html = renderToStaticMarkup(GuidedFramePairPanel({ pair: env.pair, input: env.input, disabled: false, reviewed: false, onSave: vi.fn(), onReview: vi.fn(), onAssets: vi.fn(), onBalance: vi.fn() }));
  expect(html).toContain('aria-label="End image progress"'); expect(html).toContain("Creating image");
  expect(html).toContain("Kept when End changes"); expect(html).not.toContain("aria-valuenow");
  expect(html).not.toContain("Checking saved End"); expect(html).not.toContain("Last checked");
});
it("cannot replace both frames while an End revision has no reconciled job yet", async () => {
  const env = readyPair(), revised = newEndRevision(env.pair!, env.input, "retained-start");
  const pending = fixture(revised); pending.bothReady = false; pending.matches = false;
  pending.jobs = { start: { ...env.jobs.start, continuationError: "Earlier original End pause" } };
  expect(offersAnotherPair(pending)).toBe(false); await run(pending); expect(pending.fetch).not.toHaveBeenCalled();
});
it("a malformed saved End revision shows a recoverable message instead of crashing the sheet", () => {
  const pair = { ...readyPair().pair!, endRevision: { requestId: crypto.randomUUID(), input: "not JSON", requestedAt: new Date().toISOString() } };
  hookState.index = 0; hookState.values = [{}, undefined, false, 0, false, "", null, {}, undefined, null, false];
  const html = renderToStaticMarkup(GuidedFramePairPanel({ pair, input, disabled: false, reviewed: false, onSave: vi.fn(), onReview: vi.fn(), onAssets: vi.fn(), onBalance: vi.fn() }));
  expect(html).toContain("could not be read"); expect(html).toContain("saved in Media"); expect(html).not.toContain("Prepare another pair");
});

it("cannot approve a pair before the customer confirms the manual property comparison", async () => {
  const env = fixture(newFramePair(input)); env.manualReview = "";
  await run(env, "review"); expect(env.fetch).not.toHaveBeenCalled(); expect(env.onReview).not.toHaveBeenCalled();
});

it("selects a retained Start with only a use request, preserving the original pair identities", async () => {
  const pair = newFramePair(input), env = fixture(pair);
  env.jobs.start = { id: "existing-start", status: "CANDIDATE", asset: { id: "accepted-start" } };
  env.fetch.mockResolvedValue({ ok: true, json: async () => ({ asset: { id: "accepted-start" } }) });
  await run(env, "keepStart");
  expect(env.fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(env.fetch.mock.calls[0][1].body)).toEqual({ action: "use", jobId: "existing-start" });
  expect(env.onSave.mock.calls[0][0]).toMatchObject({ id: pair.id, startRequestId: pair.startRequestId, endRequestId: pair.endRequestId, startAssetId: "accepted-start" });
  expect(env.onUseStart).toHaveBeenCalledWith({ id: "accepted-start" });
});
it("does not attach an old pair Start to a newly chosen property's reference", async () => {
  const env = fixture(newFramePair(input)); env.input = { ...input, source: { assetId: "different-house", atMs: 0 } };
  env.jobs.start = { id: "existing-start", status: "CANDIDATE" };
  await run(env, "keepStart"); expect(env.fetch).not.toHaveBeenCalled();
});
