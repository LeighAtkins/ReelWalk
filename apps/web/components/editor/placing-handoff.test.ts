import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Exercise the actual editor callback without replacing its state transition with a test copy.
const source = ts.createSourceFile("editor.tsx", readFileSync(new URL("./editor.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.Expression | undefined;
function find(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "openCorners" && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
  ts.forEachChild(node, find);
}
find(source);
if (!callback) throw new Error("Editor corner handoff callback was not found");
const code = ts.transpileModule(`const handler = ${callback.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

describe("editor full-screen placing handoff", () => {
  it.each([undefined, "corners", "cutouts"] as const)("releases the modal before opening %s without changing title edits", (tool) => {
    const editedTitle = { text: "Updated room title", surface: [0.1, 0.2, 0.8, 0.2, 0.8, 0.7, 0.1, 0.7] };
    const state = { sheet: "pin" as string | null, checking: true, placing: false as false | "corners" | "cutouts", theater: false, title: editedTitle };
    const pause = vi.fn();
    const handler = new Function("playerRef", "setSheet", "setChecking", "setPlacing", "setTheater", `${code}; return handler;`)(
      { current: { pause } }, (value: string | null) => { state.sheet = value; }, (value: boolean) => { state.checking = value; },
      (value: "corners" | "cutouts") => { expect(state.sheet).toBeNull(); state.placing = value; }, (value: boolean) => { state.theater = value; },
    );
    handler(tool);
    expect(pause).toHaveBeenCalledOnce();
    expect(state).toEqual({ sheet: null, checking: false, placing: tool ?? "corners", theater: true, title: editedTitle });
    expect(state.title).toBe(editedTitle);
  });
});
