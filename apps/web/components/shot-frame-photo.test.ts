import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), load: vi.fn(), seek: vi.fn(), release: vi.fn() }));
vi.mock("./editor/frame-service", () => ({ loadVideo: mocks.load, seekVideo: mocks.seek, releaseVideo: mocks.release }));
vi.mock("@/app/inspect-actions", () => ({ inspectSource: mocks.inspect }));
import { shotFramePhoto } from "./shot-frame-photo";
const draw = vi.fn();
beforeEach(() => {
  vi.resetAllMocks(); mocks.inspect.mockResolvedValue({ url: "/original-4k.mp4", expiresInSeconds: 300 }); mocks.load.mockResolvedValue({ videoWidth: 3840, videoHeight: 2160, currentTime: 0, duration: 8 });
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: draw }), toBlob: (done: (blob: Blob | null) => void) => done(new Blob(["frame"], { type: "image/jpeg" })) }) });
});
afterEach(() => vi.unstubAllGlobals());
it("saves the exact selected source time as a full-aspect photo without applying reel effects", async () => {
  const asset = { id: "video", url: "/preview-720p.mp4", fileName: "Tour.mp4" };
  const file = await shotFramePhoto(asset.id, asset.fileName, 6240);
  expect(mocks.inspect).toHaveBeenCalledWith({ assetId: asset.id });
  expect(mocks.load).toHaveBeenCalledWith("/original-4k.mp4"); expect(mocks.load).not.toHaveBeenCalledWith(asset.url); expect(mocks.seek).toHaveBeenCalledWith(expect.anything(), 6240);
  expect(file.name).toBe("Tour.mp4 frame 6240ms.jpg"); expect(file.type).toBe("image/jpeg");
  expect(draw).toHaveBeenCalledWith(expect.anything(), 0, 0, 3840, 2160); expect(mocks.release).toHaveBeenCalledOnce();
});
it("does not decode a proxy or upload a substitute when original resolution fails", async () => {
  for (const outcome of [null, Error("Original lookup failed")]) {
    if (outcome instanceof Error) mocks.inspect.mockRejectedValueOnce(outcome); else mocks.inspect.mockResolvedValueOnce(outcome);
    await expect(shotFramePhoto("video", "Tour.mp4", 6240)).rejects.toThrow();
    expect(mocks.load).not.toHaveBeenCalled(); expect(draw).not.toHaveBeenCalled();
  }
});
it("does not substitute another frame when seeking fails", async () => {
  mocks.seek.mockRejectedValue(Error("decode failed"));
  await expect(shotFramePhoto("/original.mp4", "Tour", 6240)).rejects.toThrow("decode failed");
  expect(draw).not.toHaveBeenCalled(); expect(mocks.release).toHaveBeenCalledOnce();
});
it("rejects an out-of-range time and releases the video", async () => {
  await expect(shotFramePhoto("/original.mp4", "Tour", 9000)).rejects.toThrow("outside");
  expect(draw).not.toHaveBeenCalled(); expect(mocks.release).toHaveBeenCalledOnce();
});
it("handles a failed canvas encoding without leaving a decoder open", async () => {
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => ({ drawImage: draw }), toBlob: (done: (blob: null) => void) => done(null) }) });
  await expect(shotFramePhoto("/original.mp4", "Tour", 0)).rejects.toThrow("Could not save"); expect(mocks.release).toHaveBeenCalledOnce();
});
