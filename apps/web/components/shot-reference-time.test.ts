import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";

const source = ts.createSourceFile("panel.tsx", readFileSync(new URL("./ai-video-panel.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let body = "";
const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && ["source", "picker", "addReference"].includes(node.name?.text ?? "")) body += node.getText(source) + "\n"; ts.forEachChild(node, visit); }; visit(source);
const code = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: "element" } }).outputText;
function fixture(atMs: number) {
  const asset = { id: "video", kind: "VIDEO", fileName: "Original walkthrough.mp4" };
  return { firstMs: atMs, lastMs: 0, startBase: "asset:video", photo: "asset:video", last: "", firstFrame: { assetId: "video", atMs }, lastFrame: undefined,
    clips: [], allPhotos: [asset], busy: false, camera: false, ShotSourcePicker: "ShotSourcePicker", element: (_type: unknown, props: { frame: { assetId: string; atMs: number }; onTimeChange(value: number): void }) => props,
    aiBoundary: vi.fn(), setFirstMs: vi.fn(), setLastMs: vi.fn(), chooseSource: vi.fn(), mediaLock: { current: false }, recoveryKey: "own-shot", scope: { current: "own-shot" }, alive: { current: true },
    assetFor: vi.fn(() => asset), setBusy: vi.fn(), setError: vi.fn(), setMediaProgress: vi.fn(), onLibraryAsset: vi.fn(), receiveAssets: vi.fn(), setMode: vi.fn(),
    shotFramePhoto: vi.fn().mockResolvedValue(new File(["fixture"], "frame.jpg", { type: "image/jpeg" })),
    uploadFile: vi.fn().mockResolvedValue({ id: "saved-frame", kind: "IMAGE", isPano: false }) };
}
const actions = (env: ReturnType<typeof fixture>) => new Function(...Object.keys(env), `${code};return {picker,addReference};`)(...Object.values(env)) as {
  picker(ending: boolean, original?: boolean): { frame: { assetId: string; atMs: number }; onTimeChange(value: number): void };
  addReference(ending: boolean): Promise<void>;
};

it("shows the same library-video timestamp that Save this frame captures", async () => {
  const env = fixture(1250), panel = actions(env), preview = panel.picker(false, true);
  expect(preview.frame).toEqual({ assetId: "video", atMs: 1250 });
  await panel.addReference(false);
  expect(env.shotFramePhoto).toHaveBeenCalledWith(preview.frame.assetId, "Original walkthrough.mp4", preview.frame.atMs);
});
it("keeps an edited timestamp in the next controlled preview and capture", async () => {
  const initial = fixture(1250); actions(initial).picker(false, true).onTimeChange(3750);
  expect(initial.setFirstMs).toHaveBeenCalledWith(3750);
  const env = fixture(initial.setFirstMs.mock.calls[0][0]), panel = actions(env), preview = panel.picker(false, true);
  expect(preview.frame.atMs).toBe(3750);
  await panel.addReference(false);
  expect(env.shotFramePhoto).toHaveBeenCalledWith("video", "Original walkthrough.mp4", 3750);
});
it("keeps manual Start frame selection unchanged", () => {
  const env = fixture(2250);
  expect(actions(env).picker(false).frame).toEqual(env.firstFrame);
});
