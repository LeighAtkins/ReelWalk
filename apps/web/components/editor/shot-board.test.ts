import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import ts from "typescript";
import { Filmstrip } from "./filmstrip";
import { createClock } from "./clock";
import styles from "./shot-board.module.css";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { emptyTimeline, insertShotCard } from "@reelwalk/core";
import { ShotBoard } from "./shot-board";
it("offers a blank start and per-slot upload, preparation and accessible actions without requests", () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  try {
    const props = { timeline: emptyTimeline(), library: {}, onChange: vi.fn(), onPrepare: vi.fn(), onAsset: vi.fn() };
    expect(renderToStaticMarkup(createElement(ShotBoard, props))).toContain("+ Add shot");
    const html = renderToStaticMarkup(createElement(ShotBoard, { ...props, timeline: insertShotCard(props.timeline, "reserved") }));
    for (const text of ["Shot 1", "Insert shot before 1", "Upload / replace photo", "Prepare Start / End", "Shot actions", "Only completed shots play and export"]) expect(html).toContain(text);
    expect(fetch).not.toHaveBeenCalled(); expect(html).not.toContain("<video");
  } finally { vi.unstubAllGlobals(); }
});

it("retains the exact card/source when an upload fails or its destination is deleted", async () => {
  const source = ts.createSourceFile("board.tsx", readFileSync(new URL("./shot-board.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body = "";
  const find = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === "upload") body = node.getText(source); ts.forEachChild(node, find); }; find(source);
  const code = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const core = await import("@reelwalk/core");
  let timeline = insertShotCard(emptyTimeline(), "target");
  const file = { name: "house.jpg", type: "image/jpeg", size: 42 };
  const onAsset = vi.fn(), setError = vi.fn();
  const environment = { lock: { current: false }, setUploading: vi.fn(), setError, onAsset, updateShotCard: core.updateShotCard,
    onChange: (fn: (t: typeof timeline) => typeof timeline) => { timeline = fn(timeline); }, uploadFile: vi.fn().mockRejectedValueOnce(Error("offline")) };
  const upload = new Function(...Object.keys(environment), `${code};return upload;`)(...Object.values(environment));
  const before = timeline;
  await upload("target", file);
  expect(timeline).toBe(before); expect(onAsset).not.toHaveBeenCalled(); expect(setError).toHaveBeenLastCalledWith("offline");
  environment.uploadFile.mockImplementationOnce(async () => { timeline = core.removeShotCard(timeline, "target"); return { id: "retained", kind: "IMAGE" }; });
  await upload("target", file);
  expect(core.shotCards(timeline)).toEqual([]); expect(timeline.clips).toEqual([]); expect(onAsset).toHaveBeenCalledWith({ id: "retained", kind: "IMAGE" });
});
it("can produce isolated before/after markup fixtures without provider or application services", () => {
  const dir = process.env.SHOT_FIXTURE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const no = () => {};
  const legacy = renderToStaticMarkup(createElement(Filmstrip, { timeline: emptyTimeline(), library: {}, uploads: [], selection: null, clock: createClock(), onSelect: no, onOpen: no, onSeek: no, onGrab: no, onScrub: no, onTextTiming: no, onClipTrim: no, onMoveClip: no, onAddMedia: no, onAddText: no, onAddMusic: no }));
  let timeline = emptyTimeline(); for (const id of ["first", "middle", "last"]) timeline = insertShotCard(timeline, id);
  const board = renderToStaticMarkup(createElement(ShotBoard, { timeline, library: {}, onChange: no, onPrepare: no, onAsset: no, onUseTake: no }));
  let css = readFileSync(new URL("./shot-board.module.css", import.meta.url), "utf8");
  css = css.replace(/\.([a-zA-Z][a-zA-Z0-9]*)/g, (match, key: string) => styles[key] ? `.${styles[key]}` : match);
  const globals = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
  for (const [name, markup] of [["before", legacy], ["after", board + legacy]]) writeFileSync(`${dir}/${name}.html`, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${globals}\n${css}</style></head><body style="margin:0;background:#111;color:white;font-family:Arial"><h1>Isolated ${name} fixture</h1>${markup}</body></html>`);
});
