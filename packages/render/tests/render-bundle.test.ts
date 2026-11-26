import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyTimeline } from "@reelwalk/core";

const bundleMock = vi.fn<(...args: unknown[]) => Promise<string>>(async () => "");
const closeMock = vi.fn(async () => undefined);
const openBrowserMock = vi.fn<(...args: unknown[]) => Promise<{ close: typeof closeMock }>>(async () => ({ close: closeMock }));
const selectCompositionMock = vi.fn<(...args: unknown[]) => Promise<{ id: string; durationInFrames: number; fps: number; width: number; height: number }>>(async () => ({
  id: "Reel",
  durationInFrames: 90,
  fps: 30,
  width: 1080,
  height: 1920,
}));
const renderMediaMock = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
const serveBundleMock = vi.fn(async (dir: string) => ({ url: `http://localhost:39999?dir=${encodeURIComponent(dir)}`, close: async () => undefined }));

vi.mock("@remotion/bundler", () => ({
  bundle: (...args: unknown[]) => bundleMock(...args),
}));

vi.mock("@remotion/renderer", () => ({
  makeCancelSignal: () => ({ cancelSignal: () => ({ type: "continue" }), cancel: () => undefined }),
  openBrowser: (...args: unknown[]) => openBrowserMock(...args),
  selectComposition: (...args: unknown[]) => selectCompositionMock(...args),
  renderMedia: (...args: unknown[]) => renderMediaMock(...args),
  renderStill: vi.fn(),
}));

vi.mock("../src/bundle-server", () => ({
  RENDER_PAGE_PORT: 39999,
  serveBundle: (dir: string) => serveBundleMock(dir),
}));

import { computeRenderBundleStamp, readValidPrebuiltBundle, renderReel } from "../src/render-reel";

describe("pre-built Remotion bundle & browser reuse", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.REMOTION_BUNDLE_DIR;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("validates prebuilt bundle stamp strictly against source hash", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rw-bundle-test-"));
    tempDirs.push(dir);
    const stamp = computeRenderBundleStamp();
    expect(stamp).toMatch(/^[a-f0-9]{64}$/);
    expect(computeRenderBundleStamp()).toBe(stamp);

    expect(readValidPrebuiltBundle(dir, stamp)).toBeNull();
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    expect(readValidPrebuiltBundle(dir, stamp)).toBeNull();
    writeFileSync(path.join(dir, ".reelwalk-bundle-stamp.json"), JSON.stringify({ stamp: "stale" }));
    expect(readValidPrebuiltBundle(dir, stamp)).toBeNull();
    writeFileSync(path.join(dir, ".reelwalk-bundle-stamp.json"), "not-json");
    expect(readValidPrebuiltBundle(dir, stamp)).toBeNull();
    writeFileSync(path.join(dir, ".reelwalk-bundle-stamp.json"), JSON.stringify({ stamp }));
    expect(readValidPrebuiltBundle(dir, stamp)).toBe(dir);
  });

  it("reuses a matching prebuilt bundle without bundling and shares one browser across selectComposition + renderMedia", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rw-prebuilt-"));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    writeFileSync(path.join(dir, ".reelwalk-bundle-stamp.json"), JSON.stringify({ stamp: computeRenderBundleStamp() }));
    process.env.REMOTION_BUNDLE_DIR = dir;

    await renderReel({
      timeline: emptyTimeline(),
      assets: {},
      output: path.join(dir, "out.mp4"),
    });

    expect(bundleMock).not.toHaveBeenCalled();
    expect(serveBundleMock).toHaveBeenCalledWith(dir);
    expect(openBrowserMock).toHaveBeenCalledTimes(1);
    const browser = await openBrowserMock.mock.results[0]!.value;
    expect(selectCompositionMock).toHaveBeenCalledWith(expect.objectContaining({ puppeteerInstance: browser }));
    expect(renderMediaMock).toHaveBeenCalledWith(expect.objectContaining({ puppeteerInstance: browser }));
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("closes the shared browser even when renderMedia fails", async () => {
    renderMediaMock.mockRejectedValueOnce(new Error("boom"));
    const dir = mkdtempSync(path.join(os.tmpdir(), "rw-prebuilt-fail-"));
    tempDirs.push(dir);

    await expect(
      renderReel({
        timeline: emptyTimeline(),
        assets: {},
        output: path.join(dir, "out.mp4"),
      }),
    ).rejects.toThrow("boom");

    expect(openBrowserMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
