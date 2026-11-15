import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

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
    firstFrame: { assetId: "start", atMs: 0 }, lastFrame: { assetId: "end", atMs: 0 }, move: "", direction: null,
    mode: "custom", anchor: undefined, style: "source", atmosphere: "source", energy: "subtle", onAdd: undefined,
    card: {}, harmonize: false, polish: false, draft: false, reelId: "own-reel", next: undefined, clips: [],
    currentPrompt: "Prepared pair", seconds: 4, draftMode: false,
    aiShotSchema: { safeParse: () => ({ success: true, data: {} }) },
    shotCardPayloadSchema: { safeParse: () => ({ success: true, data: { approved: true } }) },
    busy: false, draftLoaded: true, state: { enabled: true, balance: { remaining: 10 }, jobs: [] }, credits: 1,
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
