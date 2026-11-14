import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LibraryAsset } from "@/lib/library";
const fixture = vi.hoisted(() => ({ picked: [] as string[] }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useId: () => "modal-title", useState: (initial: unknown) => [Array.isArray(initial) ? fixture.picked : initial, vi.fn()] };
});
import { AutopilotSheet, MediaSheet } from "./sheets";

beforeEach(() => { fixture.picked = []; });
const photos = ["first", "second"].map(id => ({ id, kind: "IMAGE", isPano: false, fileName: `${id}.jpg`, thumbUrl: `/${id}.jpg` } as LibraryAsset));
const media = () => renderToStaticMarkup(createElement(MediaSheet, { library: photos, onUpload: vi.fn(), onPick: vi.fn(), onClose: vi.fn() }));

describe("media gallery loading", () => {
  it("defers unselected thumbnails and reserves their portrait geometry", () => {
    const html = media();
    expect(html.match(/loading="lazy"/g)).toHaveLength(2);
    expect(html.match(/width="90" height="160"/g)).toHaveLength(2);
    expect(html.match(/decoding="async"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="first.jpg"');
    expect(html).toContain("Select media to add");
  });
  it("keeps explicitly selected media eager and preserves ordering and the add action", () => {
    fixture.picked = ["second"];
    const html = media();
    expect(html).toMatch(/src="\/second.jpg"[^>]*loading="eager"/);
    expect(html).toMatch(/src="\/first.jpg"[^>]*loading="lazy"/);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Add 1 to the reel");
  });
});

describe("full-screen workflow close guards", () => {
  it.each(["form", "waiting", "cutting", "exporting"] as const)("only lets the caller close during %s when idle", phase => {
    const close = vi.fn();
    const panel = AutopilotSheet({ phase, uploading: 0, shots: [], pending: [], onRoom: vi.fn(), error: null, upgrade: false, onGo: vi.fn(), onClose: close });
    panel.props.onClose();
    expect(close).toHaveBeenCalledTimes(phase === "form" ? 1 : 0);
  });
});
