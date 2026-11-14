import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const hooks = vi.hoisted(() => ({ refs: [] as unknown[], effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useRef: (initial: unknown) => hooks.refs.shift() ?? { current: initial }, useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); } };
});
import { ModalDialog, Sheet } from "./sheet";

beforeEach(() => { hooks.refs.length = 0; hooks.effects.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); });
class Opener {
  isConnected = true;
  disabled = false;
  inert = false;
  focus = vi.fn();
  matches() { return this.disabled; }
  closest() { return this.inert ? {} : null; }
}
const fixture = () => {
  const opener = new Opener();
  const page = { activeElement: opener, querySelectorAll: vi.fn((): { contains(element: unknown): boolean }[] => []) };
  vi.stubGlobal("HTMLElement", Opener); vi.stubGlobal("document", page);
  const dialog = { open: false, showModal: vi.fn(() => { dialog.open = true; }), close: vi.fn(() => { dialog.open = false; }), getBoundingClientRect: () => ({ left: 100, right: 500, top: 100, bottom: 700 }) };
  hooks.refs.push({ current: dialog });
  const close = vi.fn();
  const element = ModalDialog({ onRequestClose: close, "aria-label": "Test" });
  const event = (x: number, y: number, target: unknown = dialog) => ({ currentTarget: dialog, target, clientX: x, clientY: y });
  return { dialog, close, element, event, opener, page };
};

describe("native blocking sheets", () => {
  it("opens through showModal and closes natively only when unmounted", () => {
    const { dialog } = fixture();
    expect(dialog.showModal).not.toHaveBeenCalled();
    const dispose = hooks.effects[0]();
    expect(dialog.open).toBe(true);
    expect(typeof dispose).toBe("function");
    if (dispose) dispose();
    expect(dialog.close).toHaveBeenCalledTimes(1);
  });
  it("routes native cancellation through the caller without bypassing its close guard", () => {
    const { element, close, dialog, opener } = fixture();
    hooks.effects[0]();
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    element.props.onCancel(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true);
    expect(dialog.close).not.toHaveBeenCalled();
    expect(opener.focus).not.toHaveBeenCalled();
  });
  it("restores a connected opener even if React already detached the closing dialog", () => {
    const { opener, dialog } = fixture();
    const dispose = hooks.effects[0]();
    Object.assign(dialog, { isConnected: false });
    if (dispose) dispose();
    expect(opener.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
  it.each(["removed", "disabled", "inert"] as const)("does not restore a %s opener", state => {
    const { opener } = fixture();
    const dispose = hooks.effects[0]();
    if (state === "removed") opener.isConnected = false;
    else opener[state] = true;
    if (dispose) dispose();
    expect(opener.focus).not.toHaveBeenCalled();
  });
  it("returns to an invoker inside an open parent but never focuses behind another modal", () => {
    const { opener, page } = fixture();
    const dispose = hooks.effects[0]();
    page.querySelectorAll.mockReturnValue([{ contains: element => element === opener }]);
    if (dispose) dispose();
    expect(opener.focus).toHaveBeenCalledOnce();
    opener.focus.mockClear();
    page.querySelectorAll.mockReturnValue([{ contains: () => false }]);
    if (dispose) dispose();
    expect(opener.focus).not.toHaveBeenCalled();
  });
  it("requires both pointer press and click to be on the backdrop", () => {
    const { element, close, event } = fixture();
    element.props.onPointerDown(event(150, 150));
    element.props.onClick(event(20, 20));
    expect(close).not.toHaveBeenCalled();
    element.props.onPointerDown(event(20, 20));
    element.props.onClick(event(150, 150));
    expect(close).not.toHaveBeenCalled();
    element.props.onPointerDown(event(20, 20));
    element.props.onClick(event(20, 20));
    expect(close).toHaveBeenCalledOnce();
  });
  it("does not treat child clicks or cancelled pointer gestures as backdrop dismissal", () => {
    const { element, close, event } = fixture();
    element.props.onPointerDown(event(20, 20, {}));
    element.props.onClick(event(20, 20, {}));
    element.props.onPointerDown(event(20, 20));
    element.props.onPointerCancel();
    element.props.onClick(event(20, 20));
    expect(close).not.toHaveBeenCalled();
  });
  it("keeps accessible names and makes wide sizing opt-in without duplicate modal semantics", () => {
    const html = (size?: "wide") => renderToStaticMarkup(createElement(Sheet, { title: "Make a shot", size, onClose: vi.fn(), children: "Body" }));
    expect(html()).toContain('data-size="standard"');
    expect(html("wide")).toContain('data-size="wide"');
    expect(html()).toContain("<dialog");
    expect(html()).toContain("aria-labelledby");
    expect(html()).not.toContain('role="dialog"');
    expect(html()).not.toContain('aria-modal="true"');
    expect(html()).not.toContain("sheet-backdrop");
  });
});
