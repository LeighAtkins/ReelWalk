import { readFileSync } from "node:fs";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ createReel: vi.fn(), push: vi.fn(), pending: vi.fn() }));
vi.mock("@/app/actions", () => ({ createReel: mocks.createReel, createReelFromTour: vi.fn() }));
vi.mock("@/lib/pending-files", () => ({ setPendingFiles: mocks.pending }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
import { NewReelPicker } from "./new-reel-picker";
it("keeps existing reels in preview and reveals the footage when a timeline item is selected", () => {
  const source = ts.createSourceFile("editor.tsx", readFileSync(new URL("./editor/editor.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initial = "", select = "";
  const scan = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      if (node.name.getText(source) === "[showShots, setShowShots]") initial = node.initializer.arguments[0].getText(source);
      if (node.name.getText(source) === "selectAndShow") select = node.initializer.arguments[0].getText(source);
    }
    ts.forEachChild(node, scan);
  }; scan(source);
  const startsOnBoard = new Function("initialTimeline", `return ${initial};`);
  expect(startsOnBoard({ clips: [{ id: "legacy" }] })).toBe(false);
  expect(startsOnBoard({ clips: [] })).toBe(true);
  expect(startsOnBoard({ clips: [], shotBoard: { version: 1, cards: [] } })).toBe(true);
  const show = vi.fn(), selected = vi.fn();
  const code = ts.transpileModule(`const select = ${select};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const choose = new Function("setShowShots", "setSelection", "timeline", "clock", "seek", `${code};return select;`)(show, selected, { texts: [] }, { get: () => 0 }, vi.fn());
  choose({ kind: "clip", id: "legacy" });
  expect(show).toHaveBeenCalledWith(false);
  expect(selected).toHaveBeenCalledWith({ kind: "clip", id: "legacy" });
});
it("offers a blank shot board without requiring a file or invoking creation while rendering", () => {
  const html = renderToStaticMarkup(createElement(NewReelPicker));
  expect(html).toContain('data-testid="start-blank-board"'); expect(html).toContain("Blank shot board");
  expect(mocks.createReel).not.toHaveBeenCalled();
});
it("the actual blank-entry button creates a reel with no pending files or automatic first cut", async () => {
  const source = ts.createSourceFile("picker.tsx", readFileSync(new URL("./new-reel-picker.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let start = "", click = "";
  const scan = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "start") start = node.getText(source);
    if (ts.isJsxOpeningElement(node) && node.attributes.properties.some(a => ts.isJsxAttribute(a) && a.name.getText(source) === "data-testid" && a.initializer?.getText(source) === '"start-blank-board"')) {
      const attribute = node.attributes.properties.find(a => ts.isJsxAttribute(a) && a.name.getText(source) === "onClick") as ts.JsxAttribute;
      click = (attribute.initializer as ts.JsxExpression).expression!.getText(source);
    }
    ts.forEachChild(node, scan);
  }; scan(source);
  const code = ts.transpileModule(`${start};const click = ${click};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const createReel = vi.fn().mockResolvedValue({ id: "blank" }), pending = vi.fn(), push = vi.fn();
  const startFn = new Function("setBusy", "setError", "createReel", "setPendingFiles", "router", `${code};return { start, click };`)(vi.fn(), vi.fn(), createReel, pending, { push });
  startFn.click(); await Promise.resolve(); await Promise.resolve();
  expect(createReel).toHaveBeenCalledOnce(); expect(pending).toHaveBeenCalledWith("blank", []); expect(push).toHaveBeenCalledWith("/reels/blank");
});
