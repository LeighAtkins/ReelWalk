import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { clipSchema } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { ShotSourcePicker, type ShotSourcePickerProps } from "./shot-source-picker";
import styles from "./shot-workspace.module.css";

const workspaceCss = readFileSync(new URL("./shot-workspace.module.css", import.meta.url), "utf8");

const image = { id: "home", kind: "IMAGE", fileName: "Home.jpg", url: "/home-full.jpg", thumbUrl: "/home-thumb.jpg", isPano: false } as LibraryAsset;
const video = { ...image, id: "tour", kind: "VIDEO", fileName: "Tour.mp4", url: "/tour.mp4", thumbUrl: null, durationMs: 8000 } as LibraryAsset;
const clip = clipSchema.parse({ id: "cut", assetId: video.id, kind: "VIDEO", sourceStartMs: 2000, sourceEndMs: 5000, speed: 2 });
const props = (overrides: Partial<ShotSourcePickerProps> = {}): ShotSourcePickerProps => ({
  label: "Start", value: "asset:home", frame: { assetId: image.id, atMs: 0 }, photos: [image, video], clips: [clip], onChange: vi.fn(), onTimeChange: vi.fn(), ...overrides,
});
const html = (input: ShotSourcePickerProps) => renderToStaticMarkup(createElement(ShotSourcePicker, input));
// Inspect the rendered controls to exercise their callbacks without an undeclared browser-test dependency.
function controls(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...controls(node.props.children as ReactNode)];
}
const rendered = (input: ShotSourcePickerProps) => controls(ShotSourcePicker(input));

describe("visual shot source picker", () => {
  it("shows the selected full-resolution portrait, filenames as captions and both source groups", () => {
    const markup = html(props());
    expect(markup).toContain('aria-label="Start reference"');
    expect(markup).toContain('src="/home-full.jpg"');
    expect(markup).toContain('src="/home-thumb.jpg"');
    expect(markup).toContain(styles.previewFrame);
    expect(workspaceCss).toMatch(/\.previewFrame\s*\{[^}]*aspect-ratio:\s*9\s*\/\s*16/s);
    expect(markup).toContain("object-fit:cover");
    expect(markup).toContain("Portrait framing");
    expect(markup).toContain("<figcaption");
    expect(markup).toContain("Library: Photo · Home.jpg");
    expect(markup).toContain("Reel: Shot 1 · last frame · Tour.mp4");
    expect(markup).not.toContain("<select");
  });

  it("selects reel and library values distinctly even when they refer to the same video", () => {
    const input = props({ value: "clip:cut", frame: { assetId: video.id, atMs: 4933 } });
    const buttons = rendered(input).filter(node => node.type === "button");
    const reel = buttons.find(node => String(node.props["aria-label"]).startsWith("Reel:"))!;
    const library = buttons.find(node => node.props["aria-label"] === "Library: Video · Tour.mp4")!;
    expect(reel.props["aria-pressed"]).toBe(true);
    expect(library.props["aria-pressed"]).toBe(false);
    (reel.props.onClick as () => void)();
    (library.props.onClick as () => void)();
    expect(input.onChange).toHaveBeenNthCalledWith(1, "clip:cut");
    expect(input.onChange).toHaveBeenNthCalledWith(2, "asset:tour");
    const markup = html(input);
    expect(markup).toContain("4.933s");
    expect(markup).toContain("last source frame");
    expect(markup).not.toContain('type="number"');
  });

  it("shows the first trimmed boundary for End and updates selected state on new props", () => {
    const markup = html(props({ label: "End", value: "clip:cut", frame: { assetId: video.id, atMs: 2000 } }));
    expect(markup).toContain("Reel: Shot 1 · first frame");
    expect(markup).toContain("2.000s");
    expect(markup).toContain("first source frame");
    const next = rendered(props({ value: "asset:tour", frame: { assetId: video.id, atMs: 3000 } }));
    expect(next.find(node => node.props["aria-label"] === "Library: Video · Tour.mp4")?.props["aria-pressed"]).toBe(true);
    expect(next.find(node => node.props["aria-label"] === "Library: Photo · Home.jpg")?.props["aria-pressed"]).toBe(false);
  });

  it("offers time control only for library videos and bounds changes within the source", () => {
    const input = props({ value: "asset:tour", frame: { assetId: video.id, atMs: 3000 } });
    const time = rendered(input).find(node => node.type === "input")!;
    expect(time.props.value).toBe(3);
    const change = time.props.onChange as (event: { currentTarget: { valueAsNumber: number } }) => void;
    for (const valueAsNumber of [4.123, -1, 80, NaN]) change({ currentTarget: { valueAsNumber } });
    expect(input.onTimeChange).toHaveBeenNthCalledWith(1, 4123);
    expect(input.onTimeChange).toHaveBeenNthCalledWith(2, 0);
    expect(input.onTimeChange).toHaveBeenNthCalledWith(3, 7999);
    expect(input.onTimeChange).toHaveBeenCalledTimes(3);
    expect(rendered(props()).some(node => node.type === "input")).toBe(false);
  });

  it("filters unsupported and panoramic sources, offers explicit clearing and reports missing references", () => {
    const input = props({ allowVideos: false, allowNone: true, value: "asset:missing", frame: { assetId: "missing", atMs: 0 }, photos: [image, video, { ...image, id: "pano", isPano: true }, { ...image, id: "webp", fileName: "Room.webp" }] });
    const markup = html(input);
    expect(markup).toContain("This reference is unavailable. Choose another below.");
    expect(markup).not.toContain("Tour.mp4");
    expect(markup).not.toContain("Room.webp");
    const clear = rendered(input).find(node => node.props.children === "No reference")!;
    (clear.props.onClick as () => void)();
    expect(input.onChange).toHaveBeenCalledWith("");
    expect(html(props({ photos: [], clips: [] }))).toContain("Add a JPEG or PNG photo or video");
  });

  it("disables all source and time controls while the parent is busy", () => {
    const nodes = rendered(props({ value: "asset:tour", frame: { assetId: video.id, atMs: 0 }, disabled: true, allowNone: true }));
    for (const node of nodes.filter(node => node.type === "button" || node.type === "input")) expect(node.props.disabled).toBe(true);
  });

  it("marks the selected source visibly as well as programmatically", () => {
    const markup = html(props({ value: "asset:home", frame: { assetId: image.id, atMs: 0 } }));
    expect(markup).toContain(styles.selectedMark);
    expect(markup).toContain('aria-hidden="true">✓ ');
    expect(markup).toMatch(/aria-pressed="true"[^>]*>[^]*?Library/);
    expect(markup).not.toContain("max-width:216px");
  });
});
