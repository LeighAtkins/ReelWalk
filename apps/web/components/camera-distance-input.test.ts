import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { parseCameraDistance } from "./camera-distance-input";

it("accepts useful camera distances and rejects blanks and values beyond the bounded range", () => {
  expect(parseCameraDistance("")).toBeNull();
  expect(parseCameraDistance("30")).toBe(30);
  expect(parseCameraDistance("100")).toBe(100);
  expect(parseCameraDistance("0.5")).toBe(0.5);
  expect(parseCameraDistance("0,5")).toBe(0.5);
  for (const text of ["0.4", "101", "1e2", "NaN", "-3"]) expect(parseCameraDistance(text)).toBeNull();
});
it("keeps temporary empty text editable, blocks it, and commits30/100 without clamping", () => {
  const file = ts.createSourceFile("input.tsx", readFileSync(new URL("./camera-distance-input.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body = "";
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === "edit") body = node.getText(file); ts.forEachChild(node, visit); }; visit(file);
  const code = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const setDraft = vi.fn(), onValidityChange = vi.fn(), onChange = vi.fn();
  const edit = new Function("setDraft", "onValidityChange", "onChange", "parseCameraDistance", `${code};return edit;`)(setDraft, onValidityChange, onChange, parseCameraDistance);
  edit(""); expect(setDraft).toHaveBeenLastCalledWith(""); expect(onValidityChange).toHaveBeenLastCalledWith(false); expect(onChange).not.toHaveBeenCalled();
  edit("30"); expect(onValidityChange).toHaveBeenLastCalledWith(true); expect(onChange).toHaveBeenLastCalledWith(30);
  edit("100"); expect(onChange).toHaveBeenLastCalledWith(100);
  edit("101"); expect(setDraft).toHaveBeenLastCalledWith("101"); expect(onValidityChange).toHaveBeenLastCalledWith(false); expect(onChange).toHaveBeenLastCalledWith(100);
});
