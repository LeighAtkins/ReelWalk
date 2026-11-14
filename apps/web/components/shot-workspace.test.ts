import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { clipSchema } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { AiVideoPanel } from "./ai-video-panel";

const photo = { id: "room-photo", kind: "IMAGE", fileName: "Living room.jpg", url: "/room-full.jpg", thumbUrl: "/room-thumb.jpg", isPano: false } as LibraryAsset;
const clip = clipSchema.parse({ id: "selected-room", assetId: photo.id, kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 4000 });

describe("image-first shot workspace", () => {
  it("keeps frames, direction, image review and video action in a usable linear reading order", () => {
    const html = renderToStaticMarkup(createElement(AiVideoPanel, { photos: [photo], clips: [clip], selectedClip: clip, reelId: "property" }));
    const order = ["Shot references", "Shot direction", "Review prepared images", "More shot options", "Generate video"];
    const positions = order.map(text => html.indexOf(text));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toContain('aria-label="Start reference"');
    expect(html).toContain('aria-label="End reference"');
    expect(html).toContain("Living room.jpg");
    expect(html).toContain('src="/room-full.jpg"');
    expect(html).toMatch(/<details[^>]*><summary>More shot options/);
    expect(html).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/);
  });

  it("never starts or enables image/video spending while credit/history recovery is pending", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    try {
      const html = renderToStaticMarkup(createElement(AiVideoPanel, { photos: [photo], clips: [clip], selectedClip: clip, reelId: "property" }));
      expect(fetch).not.toHaveBeenCalled();
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Generate End image/);
      expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Generate video/);
      expect(html).not.toContain("Use this End");
    } finally { vi.unstubAllGlobals(); }
  });
});
