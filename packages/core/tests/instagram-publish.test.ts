import { describe, expect, it } from "vitest";
import { CONTAINER_STATUS_FIELDS, DEFAULT_COVER_FRAME_MS, isContainerId, publishParams, reelContainerParams, storyContainerParams } from "../src/instagram-publish";

describe("reel container", () => {
  it("is a REELS container shared to the feed with the cover frame", () => {
    expect(reelContainerParams({ videoUrl: "https://cdn.example/r.mp4", caption: "Hello" })).toEqual({
      media_type: "REELS",
      video_url: "https://cdn.example/r.mp4",
      caption: "Hello",
      share_to_feed: "true",
      thumb_offset: String(DEFAULT_COVER_FRAME_MS),
    });
  });

  it("adds the sound and the AI disclosure only when asked, and trims the caption", () => {
    const params = reelContainerParams({
      videoUrl: "https://cdn.example/r.mp4",
      caption: "x".repeat(3000),
      coverMs: 1234.6,
      audio: { audioId: "99", audioVolume: 100, videoVolume: 20 },
      aiGenerated: true,
    });
    expect(params.caption).toHaveLength(2200);
    expect(params.thumb_offset).toBe("1235");
    expect(JSON.parse(params.audio_configuration)).toEqual({ audio_id: "99", audio_volume: 100, video_volume: 20 });
    expect(params.is_ai_generated).toBe("true");
    expect(reelContainerParams({ videoUrl: "u", caption: "", aiGenerated: false })).not.toHaveProperty("is_ai_generated");
  });
});

describe("story container", () => {
  it("is a STORIES container with the video and nothing Instagram refuses for stories", () => {
    expect(storyContainerParams({ videoUrl: "https://cdn.example/s.mp4", aiGenerated: true })).toEqual({
      media_type: "STORIES",
      video_url: "https://cdn.example/s.mp4",
      is_ai_generated: "true",
    });
    const params = storyContainerParams({ videoUrl: "https://cdn.example/s.mp4" });
    expect(params).toEqual({ media_type: "STORIES", video_url: "https://cdn.example/s.mp4" });
    for (const key of ["caption", "share_to_feed", "thumb_offset", "audio_configuration", "cover_url"]) expect(params).not.toHaveProperty(key);
  });

  it("takes an image instead, and needs one or the other", () => {
    expect(storyContainerParams({ imageUrl: "https://cdn.example/s.jpg" })).toEqual({ media_type: "STORIES", image_url: "https://cdn.example/s.jpg" });
    expect(() => storyContainerParams({} as never)).toThrow(/video or an image/);
  });
});

describe("publish and status", () => {
  it("publishes by creation id and reads the status fields", () => {
    expect(publishParams("17890000000000000")).toEqual({ creation_id: "17890000000000000" });
    expect(CONTAINER_STATUS_FIELDS).toBe("status_code,status");
  });

  it("recognises a container id", () => {
    expect(isContainerId("17890000000000000")).toBe(true);
    expect(isContainerId("abc")).toBe(false);
    expect(isContainerId("1234")).toBe(false);
  });
});
