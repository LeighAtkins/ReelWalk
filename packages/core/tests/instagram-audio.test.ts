import { describe, expect, it } from "vitest";
import {
  instagramAudioConfiguration,
  instagramAudioLabel,
  instagramAudioMix,
  parseInstagramAudioChoice,
  parseInstagramAudioSearch,
  searchFakeInstagramAudio,
} from "../src";

describe("instagramAudioConfiguration", () => {
  it("is the JSON string the Graph API expects", () => {
    const value = instagramAudioConfiguration({ audioId: "1234567890", audioVolume: 100, videoVolume: 0 });
    expect(typeof value).toBe("string");
    expect(JSON.parse(value)).toEqual({ audio_id: "1234567890", audio_volume: 100, video_volume: 0 });
  });

  it("keeps volumes whole numbers between 0 and 100", () => {
    expect(JSON.parse(instagramAudioConfiguration({ audioId: "a", audioVolume: 140, videoVolume: -5 }))).toEqual({ audio_id: "a", audio_volume: 100, video_volume: 0 });
    expect(JSON.parse(instagramAudioConfiguration({ audioId: "a", audioVolume: 34.6, videoVolume: Number.NaN }))).toEqual({ audio_id: "a", audio_volume: 35, video_volume: 0 });
  });

  it("mixes the reel's own audio out by default and under the sound when kept", () => {
    expect(instagramAudioMix(false)).toEqual({ audioVolume: 100, videoVolume: 0 });
    expect(instagramAudioMix(true)).toEqual({ audioVolume: 100, videoVolume: 35 });
  });
});

describe("parseInstagramAudioSearch", () => {
  it("reads the list under `audio`, not `data`", () => {
    const body = {
      audio: [
        {
          audio_id: "111",
          title: "Bright Rooms",
          display_artist: "Library Artist",
          duration_in_ms: 61234,
          cover_artwork_thumbnail_uri: "https://scontent.cdninstagram.com/cover.jpg",
          download_url: "https://scontent.cdninstagram.com/preview.m4a",
          audio_type: "music",
        },
        { audio_id: 222, title: "", ig_username: "somecreator", duration_in_ms: 15000, audio_type: "original_sound" },
      ],
    };
    expect(parseInstagramAudioSearch(body, "music")).toEqual([
      {
        id: "111",
        type: "music",
        title: "Bright Rooms",
        artist: "Library Artist",
        durationMs: 61234,
        coverUrl: "https://scontent.cdninstagram.com/cover.jpg",
        previewUrl: "https://scontent.cdninstagram.com/preview.m4a",
      },
      { id: "222", type: "original_sound", title: "Original audio", artist: "@somecreator", durationMs: 15000, coverUrl: null, previewUrl: null },
    ]);
    expect(parseInstagramAudioSearch({ data: body.audio }, "music")).toEqual([]);
  });

  it("skips malformed and repeated items and drops non-https links", () => {
    const body = {
      audio: [
        null,
        { title: "no id" },
        { audio_id: "9", title: "Kept", download_url: "http://insecure.example/a.mp3", cover_artwork_thumbnail_uri: "javascript:alert(1)" },
        { audio_id: "9", title: "Again" },
      ],
    };
    const tracks = parseInstagramAudioSearch(body, "original_sound");
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ id: "9", title: "Kept", type: "original_sound", previewUrl: null, coverUrl: null, durationMs: null });
  });

  it("answers an empty list for anything that is not a search result", () => {
    expect(parseInstagramAudioSearch(undefined, "music")).toEqual([]);
    expect(parseInstagramAudioSearch({ audio: "nope" }, "music")).toEqual([]);
  });
});

describe("parseInstagramAudioChoice", () => {
  it("accepts a well-formed choice and normalises an empty artist", () => {
    expect(parseInstagramAudioChoice({ audioId: "123", title: " Song ", artist: "", audioVolume: 100, videoVolume: 35 })).toEqual({
      audioId: "123",
      title: "Song",
      artist: null,
      audioVolume: 100,
      videoVolume: 35,
    });
  });

  it("refuses odd ids and volumes", () => {
    expect(parseInstagramAudioChoice({ audioId: "1 OR 1=1", title: "x", audioVolume: 100, videoVolume: 0 })).toBeNull();
    expect(parseInstagramAudioChoice({ audioId: "1", title: "x", audioVolume: 101, videoVolume: 0 })).toBeNull();
    expect(parseInstagramAudioChoice(null)).toBeNull();
  });
});

describe("the pretend search", () => {
  it("returns everything of a type when empty, and matches title or artist", () => {
    expect(searchFakeInstagramAudio("music", "").every((track) => track.type === "music")).toBe(true);
    expect(searchFakeInstagramAudio("music", "kitchen").map((track) => track.id)).toEqual(["fake-music-2"]);
    expect(searchFakeInstagramAudio("original_sound", "agent").map((track) => track.id)).toEqual(["fake-sound-2"]);
  });

  it("labels a sound in one line", () => {
    expect(instagramAudioLabel({ title: "Song", artist: "Band" })).toBe("Song · Band");
    expect(instagramAudioLabel({ title: "Song", artist: null })).toBe("Song");
  });
});
