import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cameraSketchIntent, cameraSketchSchema, clampSketchPoint } from "./camera-sketch";
import { CameraSketchControl } from "./camera-sketch-control";

describe("camera intent sketch", () => {
  it.each([[30, 0, "shift-right"], [-30, 0, "shift-left"], [0, -30, "push-in"], [0, 30, "pull-back"]])("maps a drawn displacement into validated camera guidance", (x, y, move) => {
    expect(cameraSketchIntent({ start: { x: 0, y: 0 }, end: { x: x as number, y: y as number } })).toEqual({ move, distanceM: 3 });
  });
  it("rejects collapsed, out-of-bounds and non-finite paths instead of using old guidance", () => {
    expect(cameraSketchIntent({ start: { x: 0, y: 0 }, end: { x: 0, y: 0 } })).toBeNull();
    expect(cameraSketchIntent({ start: { x: 0, y: 0 }, end: { x: 101, y: 0 } })).toBeNull();
    expect(cameraSketchSchema.safeParse({ start: { x: NaN, y: 0 }, end: { x: 0, y: 20 } }).success).toBe(false);
    expect(clampSketchPoint(65, -70)).toEqual({ x: 50, y: -50 });
  });
  it("provides named draggable handles, keyboard sliders and honest geometry limits before spending", () => {
    const html = renderToStaticMarkup(createElement(CameraSketchControl, { disabled: false, onChange() {} }));
    expect(html).toContain('aria-label="Camera start position"'); expect(html).toContain('aria-label="Camera end position"');
    expect(html.match(/type="range"/g)).toHaveLength(4);
    expect(html).toContain("not a map of your photo"); expect(html).toContain("approximate creative guidance");
  });
});
