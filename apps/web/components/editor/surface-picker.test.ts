import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseTimeline, type Clip } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { SurfacePicker } from "./surface-picker";
import { PinSheet } from "./sheets";

// "Put on a surface" at the top of the Pin sheet (ADR 0075), rendered as the server would. The flow itself (frames, model, tracker) is
// covered in core and in lib/surface-service.test.ts; this is the entry point: one tap away on a title, absent where it cannot work.

const timeline = parseTimeline({ version: 1, clips: [{ id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 }], texts: [{ id: "t", text: "THE LODGE", startMs: 0, endMs: 2000, style: "elegant" }], music: null });
const text = timeline.texts[0];
const clip = timeline.clips[0] as Clip;
const asset = { id: "v1", kind: "VIDEO", url: "https://cdn.example/v1.mp4", fileName: "v1.mp4" } as unknown as LibraryAsset;
const noop = () => undefined;

describe("Put on a surface", () => {
  it("is one button, with a line on what it does, on a title over a shot", () => {
    const html = renderToStaticMarkup(createElement(SurfacePicker, { text, clip, asset, clipStartMs: 0, onPlace: noop }));
    expect(html).toContain("Put on a surface");
    expect(html).toContain('data-testid="put-on-surface"');
    expect(html).not.toContain("disabled");
    expect(html).toMatch(/wall, floor, sky or snow/);
    // Nothing is drawn or claimed before it is tapped.
    expect(html).not.toContain("surface-candidates");
    expect(html).not.toContain('role="status"');
  });

  it("cannot be tapped, and says why, when the title is not over a shot", () => {
    const html = renderToStaticMarkup(createElement(SurfacePicker, { text, clip: null, asset: undefined, clipStartMs: 0, onPlace: noop }));
    expect(html).toContain("disabled");
    expect(html).toContain("needs the title to start on a shot");
  });

  it("sits at the top of the Pin sheet, above setting the corners by hand, only where the editor can place a title", () => {
    const sheet = (onPlaceOnSurface?: () => void) => renderToStaticMarkup(createElement(PinSheet, { text, clip, asset, clipStartMs: 0, onPath: noop, onClose: noop, onPlaceOnSurface }));
    const html = sheet(noop);
    expect(html.indexOf("Put on a surface")).toBeGreaterThan(-1);
    expect(html.indexOf("Put on a surface")).toBeLessThan(html.indexOf("Set the four corners"));
    expect(html).toContain("Or set the surface yourself.");
    expect(sheet()).not.toContain("Put on a surface");
  });
});
