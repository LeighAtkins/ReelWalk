import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { parseCameraDistance } from "./camera-distance-input";

const file = ts.createSourceFile("panel.tsx", readFileSync(new URL("./ai-video-panel.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let payloadCode = "", disabledCode = "";
const visit = (node: ts.Node) => {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "videoPayload") payloadCode = node.getText(file);
  if (ts.isJsxOpeningElement(node) && node.tagName.getText(file) === "button" && node.attributes.properties.some(p => ts.isJsxAttribute(p) && p.name.getText(file) === "type" && p.initializer?.getText(file) === '"submit"')) {
    const attr = node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(file) === "disabled") as ts.JsxAttribute;
    disabledCode = (attr.initializer as ts.JsxExpression).expression!.getText(file);
  }
  ts.forEachChild(node, visit);
}; visit(file);
const code = ts.transpileModule(payloadCode, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture(guided: boolean, pairReviewed: boolean, startImageBlocked: boolean, endImageBlocked: boolean) {
  return { guided, pairReviewed, startImageBlocked, endImageBlocked, useEndReference: false, bridge: false,
    firstFrame: { assetId: "start", atMs: 0 }, lastFrame: { assetId: "end", atMs: 0 }, move: "", direction: null as string | null,
    mode: "custom", anchor: undefined, style: "source", atmosphere: "source", energy: "subtle", onAdd: undefined,
    card: {}, harmonize: false, polish: false, draft: false, reelId: "own-reel", next: undefined, clips: [],
    currentPrompt: "Prepared pair", seconds: 4, draftMode: false,
    aiShotSchema: { safeParse: () => ({ success: true, data: {} }) },
    shotCardPayloadSchema: { safeParse: () => ({ success: true, data: { approved: true } }) },
    busy: false, draftLoaded: true, distanceValid: true, state: { enabled: true, balance: { remaining: 10 }, jobs: [] }, credits: 1,
    AI_QUEUE_LIMIT: 3, active: () => false, assetFor: () => ({ kind: "IMAGE" }) };
}
const actions = (env: ReturnType<typeof fixture>) => new Function(...Object.keys(env), `${code};return { payload:videoPayload,disabled:()=>Boolean(${disabledCode}) };`)(...Object.values(env)) as { payload(): unknown; disabled(): boolean };

it.each([[true, false], [false, true], [true, true]])("ignores retained manual blockers for an approved guided pair: %s/%s", (start, end) => {
  const panel = actions(fixture(true, true, start, end));
  expect(panel.disabled()).toBe(false); expect(() => panel.payload()).not.toThrow();
});
it.each([[true, false], [false, true], [true, true]])("preserves individual-frame admission blockers: %s/%s", (start, end) => {
  const panel = actions(fixture(false, false, start, end));
  expect(panel.disabled()).toBe(true); expect(() => panel.payload()).toThrow("Finish reviewing");
});
it("still requires explicit approval of both guided frames", () => {
  const panel = actions(fixture(true, false, true, true));
  expect(panel.disabled()).toBe(true); expect(() => panel.payload()).toThrow("Review and select both");
});
it("blocks invalid distance text instead of submitting the previous saved distance", () => {
  const env = { ...fixture(true, true, false, false), direction: "rise", distanceValid: false };
  const panel = actions(env);
  expect(panel.disabled()).toBe(true); expect(() => panel.payload()).toThrow("valid camera distance");
});
it.each(["", "101", "30", "100"])("manual frame callers respect the visible distance text %j before a new paid POST", async text => {
  const callers: { input: string; disabled: string }[] = [];
  let imageInput = "";
  const scan = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "imageInput") imageInput = `const ${node.getText(file)};`;
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === "ShotKeyframePanel") {
      const expression = (name: string) => ((node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(file) === name) as ts.JsxAttribute).initializer as ts.JsxExpression).expression!.getText(file);
      callers.push({ input: expression("input"), disabled: expression("disabled") });
    }
    ts.forEachChild(node, scan);
  }; scan(file);
  expect(callers).toHaveLength(3);
  const panel = ts.createSourceFile("keyframe.tsx", readFileSync(new URL("./shot-keyframe-panel.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let generate = "";
  const find = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === "generate") generate = node.getText(panel); ts.forEachChild(node, find); }; find(panel);
  const parsed = parseCameraDistance(text), noop = () => {};
  for (const caller of callers) {
    const controls = { busy: false, draftLoaded: true, distanceValid: parsed !== null, distanceM: parsed ?? 30,
      direction: "rise", bridge: false, startImageSource: { assetId: "source", atMs: 0 }, endImageSource: { assetId: "source", atMs: 0 }, continuity: undefined, seconds: 4, frameNotes: "" };
    const source = ts.transpileModule(`${imageInput};return {input:${caller.input},disabled:${caller.disabled}};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const props = new Function(...Object.keys(controls), source)(...Object.values(controls));
    const fetch = vi.fn().mockRejectedValue(Error("mock transport stops after recording the POST"));
    const env = { ...props, pending: undefined, locked: { current: false }, historyReady: true, state: { enabled: true, balanceRemaining: 2 }, unresolved: false, job: undefined,
      setBusy: noop, setError: noop, setDismissed: noop, setFailed: noop, setLoaded: noop, setPending: noop, keyframeInputKey: JSON.stringify,
      crypto: { randomUUID: () => "fixed-request" }, write: async () => {}, storageKey: "fixture", sessionStorage: {}, fetch, mounted: { current: true } };
    const handler = ts.transpileModule(generate, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    await new Function(...Object.keys(env), `${handler};return generate();`)(...Object.values(env));
    expect(fetch).toHaveBeenCalledTimes(parsed === null ? 0 : 1);
    if (parsed !== null) expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ action: "generate", distanceM: parsed });
  }
});
it("keeps the selected Start when guided End settings change, while clearing End and review", () => {
  let reset = "";
  const find = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === "resetGeneratedFrames") reset = node.getText(file); ts.forEachChild(node, find); }; find(file);
  const code = ts.transpileModule(reset, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const calls: string[] = [];
  const env = { guided: true, card: { framePair: {} }, generatedStart: true, generatedEnd: true, startBase: "original", endBase: "", setReviewedPair: () => calls.push("review"),
    setPhoto: () => calls.push("start"), setFirstMs: () => {}, setGeneratedStart: () => {}, setLast: () => calls.push("end"), setLastMs: () => {}, setGeneratedEnd: () => {} };
  new Function(...Object.keys(env), `${code};resetGeneratedFrames();`)(...Object.values(env));
  expect(calls).toEqual(["review", "end"]);
});
it("invalidates old pair approval while a same-intent End replacement is still pending", () => {
  let expression = "";
  const find = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(file) === "pairReviewed") expression = node.initializer!.getText(file); ts.forEachChild(node, find); }; find(file);
  const env = { reviewedPair: { pairId: "pair", inputKey: "intent", startAssetId: "start", endAssetId: "old-end" },
    card: { framePair: { id: "pair", startAssetId: "start", endAssetId: "old-end", endRevision: {} as { assetId?: string } } },
    framePairMatches: () => true, guidedInput: {}, framePairIntent: () => "intent", firstFrame: { assetId: "start" }, lastFrame: { assetId: "old-end" } };
  const compiled = ts.transpileModule(`const check = () => Boolean(${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const evaluate = () => new Function(...Object.keys(env), `${compiled};return check();`)(...Object.values(env));
  expect(evaluate()).toBe(false);
  env.card.framePair.endRevision.assetId = "old-end";
  expect(evaluate()).toBe(true);
});
