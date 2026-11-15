import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CameraKeyframeInput, CameraKeyframeJob } from "@reelwalk/core";
import { keyframeInputKey, keyframeMatches, savedKeyframeInput, ShotKeyframePanel } from "./shot-keyframe-panel";

const input: CameraKeyframeInput = { role: "end", source: { assetId: "original", atMs: 0 }, continuity: { assetId: "start", atMs: 0 }, move: "shift-right", distanceM: 3, durationSeconds: 4 };
const job = { input, id: "paid-candidate" } as CameraKeyframeJob;
const source = ts.createSourceFile("panel.tsx", readFileSync(new URL("./shot-keyframe-panel.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let generateSource = "";
let storageSource = "";
function find(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "generate") generateSource = node.getText(source);
  if (ts.isVariableDeclaration(node) && ["write", "clear"].includes(node.name.getText(source))) storageSource += `const ${node.getText(source)};\n`;
  ts.forEachChild(node, find);
}
find(source);
if (!generateSource) throw Error("Keyframe generation handler missing");
const code = ts.transpileModule(storageSource + generateSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function handler(pending: unknown, current: CameraKeyframeInput, fetch: ReturnType<typeof vi.fn>, session: Map<string, string>, onRecovery?: (key: string, value: string) => Promise<boolean>) {
  const environment = { onRecovery, input: current, pending, savedKeyframeInput, keyframeInputKey, locked: { current: false }, disabled: false, historyReady: true,
    state: { enabled: true, balanceRemaining: 2 }, unresolved: !!pending, job: undefined, storageKey: "saved", choiceKey: "choice", crypto: { randomUUID: () => "original-uuid" },
    sessionStorage: { setItem: (key: string, value: string) => session.set(key, value), removeItem: (key: string) => session.delete(key) },
    localStorage: { setItem: vi.fn() }, fetch, mounted: { current: true }, currentScope: { current: "saved" }, refresh: vi.fn(),
    setBusy: vi.fn(), setError: vi.fn(), setDismissed: vi.fn(), setFailed: vi.fn(), setLoaded: vi.fn(), setPending: vi.fn(), setSelected: vi.fn(), setState: vi.fn() };
  return new Function(...Object.keys(environment), `${code}; return generate;`)(...Object.values(environment)) as (retry?: boolean) => Promise<void>;
}
describe("keyframe review identity", () => {
  it("refuses image submission when the card cannot durably save its request", async () => {
    const fetch = vi.fn(), save = vi.fn().mockResolvedValue(false), session = new Map<string, string>();
    await handler(undefined, input, fetch, session, save)();
    expect(save).toHaveBeenCalledWith("saved", JSON.stringify({ requestId: "original-uuid", inputKey: keyframeInputKey(input), input }));
    expect(fetch).not.toHaveBeenCalled(); expect(session.size).toBe(0);
  });
  it.each(["network", "500"])("recovers a request lost before reservation (%s) using its original identity and frozen choices", async failure => {
    const session = new Map<string, string>();
    const fetch = vi.fn().mockImplementationOnce(async () => {
      if (failure === "network") throw TypeError("offline before delivery");
      return Response.json({ error: "storage unavailable" }, { status: 500 });
    }).mockResolvedValueOnce(Response.json({ job: { id: "retained", requestId: "original-uuid" } }, { status: 202 }));
    await handler(undefined, input, fetch, session)();
    const pending = JSON.parse(session.get("saved")!);
    expect(pending).toEqual({ requestId: "original-uuid", inputKey: keyframeInputKey(input), input });
    // The visible controls may have changed; retry must use the saved source and move.
    await handler(pending, { ...input, move: "shift-left" }, fetch, session)(true);
    const payloads = fetch.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(payloads).toEqual([{ action: "generate", requestId: "original-uuid", ...input }, { action: "generate", requestId: "original-uuid", ...input }]);
    expect(session.has("saved")).toBe(false);
  });
  it("does not reinterpret older saved requests when the original controls are no longer visible", async () => {
    const old = { requestId: "old", inputKey: keyframeInputKey(input) };
    expect(savedKeyframeInput(old, input)).toEqual(input);
    expect(savedKeyframeInput(old, { ...input, move: "rise" })).toBeNull();
    const fetch = vi.fn();
    await handler(old, { ...input, move: "rise" }, fetch, new Map())(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("accepts only the same source, continuity, direction, distance, duration and words", () => {
    expect(keyframeMatches(job, { ...input })).toBe(true);
    const variants: CameraKeyframeInput[] = [
      { ...input, role: "start" }, { ...input, source: { assetId: "different-photo", atMs: 0 } },
      { ...input, continuity: { assetId: "changed-start", atMs: 0 } }, { ...input, move: "shift-left" },
      { ...input, distanceM: 2 }, { ...input, durationSeconds: 8 }, { ...input, prompt: "Make it dusk" },
    ];
    for (const changed of variants) expect(keyframeMatches(job, changed)).toBe(false);
    expect(keyframeMatches(job, null)).toBe(false);
  });
  it("normalizes optional whitespace without changing a real instruction", () => {
    expect(keyframeInputKey(input)).toBe(keyframeInputKey({ ...input, prompt: "  " }));
    expect(keyframeInputKey({ ...input, prompt: "dusk" })).toBe(keyframeInputKey({ ...input, prompt: " dusk " }));
  });
  it("never enables paid generation before saved history is reconciled", () => {
    const html = renderToStaticMarkup(createElement(ShotKeyframePanel, { role: "end", input, recoveryKey: "reel", onAssets() {}, onBalance() {}, onUse() {}, onKeepSource() {}, onBlocked() {} }));
    expect(html).toContain("Generate End image");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Generate End image/);
    expect(html).not.toContain("Use this End");
    expect(html).not.toContain("<video");
  });
});

it("refuses image approval after a failed comparison preview, without generating a replacement", async () => {
  let imageSource = "", readySource = "", useSource = "";
  const scan = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "image") imageSource = node.initializer!.getText(source);
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "ready") readySource = node.initializer!.getText(source);
    if (ts.isFunctionDeclaration(node) && node.name?.text === "use") useSource = node.getText(source);
    ts.forEachChild(node, scan);
  }; scan(source);
  const loaded: Record<string, boolean> = {};
  let failed: string | null = null;
  const key = "comparison", fetch = vi.fn();
  const env = { React: { createElement }, candidateKey: key, visibleKey: { current: key }, styles: { keyframeImage: "image" }, role: "end",
    setLoaded: (value: Record<string, boolean> | ((old: Record<string, boolean>) => Record<string, boolean>)) => { const next = typeof value === "function" ? value(loaded) : value; for (const k of Object.keys(loaded)) delete loaded[k]; Object.assign(loaded, next); },
    setFailed: (value: string) => { failed = value; } };
  const imageCode = ts.transpileModule(`const image = ${imageSource};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const image = new Function(...Object.keys(env), `${imageCode};return image;`)(...Object.values(env));
  const candidate = image("candidate", "/saved.jpg");
  image("source", "/source.jpg").props.onLoad(); candidate.props.onLoad();
  const ready = () => new Function("candidateKey", "loaded", "failed", `return ${readySource};`)(key, loaded, failed);
  expect(ready()).toBe(true);
  candidate.props.onError(); expect(ready()).toBe(false);
  const useCode = ts.transpileModule(useSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  await new Function("job", "input", "ready", "fetch", `${useCode};return use;`)(job, input, ready(), fetch)();
  expect(fetch).not.toHaveBeenCalled();
});
