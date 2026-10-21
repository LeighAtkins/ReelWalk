import { describe, expect, it } from "vitest";
import { SourceReader } from "./source-reader";

type Video = { src: string; videoWidth: number; videoHeight: number; duration: number; at: number | null; freed: boolean };

function harness() {
  const opened: Video[] = [];
  const seeks: { src: string; ms: number }[] = [];
  let release: (() => void) | null = null;
  const reader = new SourceReader<Video>({
    open: async (src) => { const v = { src, videoWidth: 1280, videoHeight: 720, duration: 4, at: null, freed: false }; opened.push(v); return v; },
    // A seek waits until the test lets it finish, so reads can overlap.
    seek: (v, ms) => new Promise<void>((resolve) => { seeks.push({ src: v.src, ms }); release = () => { v.at = ms; resolve(); }; }),
    free: (v) => { v.freed = true; },
  });
  const finishSeek = async () => { for (let i = 0; i < 20 && !release; i++) await Promise.resolve(); const r = release; release = null; r?.(); await new Promise((r) => setTimeout(r, 0)); };
  return { reader, opened, seeks, finishSeek };
}

describe("Inspect's source reader", () => {
  it("opens the file once, seeks to the middle of the frame and hands back the element at that frame", async () => {
    const { reader, opened, seeks, finishSeek } = harness();
    const read = reader.read("orig.mp4", "VIDEO", 1500);
    await finishSeek();
    const result = await read;
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.media.at).toBeCloseTo(1516.667, 2);
    expect(result.seekMs).toBeCloseTo(1516.667, 2);
    expect([result.width, result.height]).toEqual([1280, 720]);
    const again = reader.read("orig.mp4", "VIDEO", 1533.4);
    await finishSeek();
    expect((await again).status).toBe("ready");
    expect(opened).toHaveLength(1);
    expect(seeks.map((s) => Math.round(s.ms))).toEqual([1517, 1550]);
  });

  it("latest wins: earlier reads are dropped before they seek", async () => {
    const { reader, seeks, finishSeek } = harness();
    const first = reader.read("orig.mp4", "VIDEO", 1000);
    const second = reader.read("orig.mp4", "VIDEO", 2000);
    const third = reader.read("orig.mp4", "VIDEO", 3000);
    await finishSeek();
    await finishSeek();
    expect((await first).status).toBe("superseded");
    expect((await second).status).toBe("superseded");
    const last = await third;
    expect(last.status).toBe("ready");
    // Reads made in a row: the earlier ones are dropped before they seek, so only the last seeks.
    expect(seeks.map((s) => Math.round(s.ms))).toEqual([3017]);
  });

  it("a read made while another is seeking waits for it, then the earlier one is reported superseded", async () => {
    const { reader, seeks, finishSeek } = harness();
    const first = reader.read("orig.mp4", "VIDEO", 1000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const second = reader.read("orig.mp4", "VIDEO", 2000);
    await finishSeek();
    await finishSeek();
    expect((await first).status).toBe("superseded");
    expect((await second).status).toBe("ready");
    expect(seeks.map((s) => Math.round(s.ms))).toEqual([1017, 2017]);
  });

  it("a new file frees the old element; release frees the current one and supersedes reads in flight", async () => {
    const { reader, opened, finishSeek } = harness();
    const a = reader.read("preview.mp4", "VIDEO", 0);
    await finishSeek();
    await a;
    const b = reader.read("orig.mp4", "VIDEO", 0);
    await finishSeek();
    await b;
    await new Promise((r) => setTimeout(r, 0));
    expect(opened.map((v) => [v.src, v.freed])).toEqual([["preview.mp4", true], ["orig.mp4", false]]);
    const c = reader.read("orig.mp4", "VIDEO", 500);
    reader.release();
    await finishSeek();
    expect((await c).status).toBe("superseded");
    await new Promise((r) => setTimeout(r, 0));
    expect(opened[1].freed).toBe(true);
  });

  it("a file that cannot be opened reads as failed, so Inspect can fall back to the preview", async () => {
    const reader = new SourceReader<Video>({ open: () => Promise.reject(new Error("403")), seek: async () => undefined, free: () => undefined });
    expect((await reader.read("orig.mp4", "VIDEO", 0)).status).toBe("failed");
  });
});
