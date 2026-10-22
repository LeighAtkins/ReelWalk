import { describe, expect, it } from "vitest";
import {
  addClips,
  BEAT_SAMPLE_RATE,
  buildReelExportPayload,
  detectBeats,
  emptyTimeline,
  FAKE_INSTAGRAM_SOUND,
  fakeInstagramSoundWav,
  instagramChoiceForSound,
  instagramPreviewFormat,
  parseInstagramAudioChoice,
  instagramPreviewKeyFor,
  instagramSoundAssetId,
  isInstagramMusic,
  parseReelExportPayload,
  parseTimeline,
  reelRenderPlan,
  referencedAssetIds,
  setMusic,
  snapCutsToBeats,
  soundSyncTarget,
  type Clip,
  type Music,
  type Timeline,
} from "../src";

/**
 * Editing a reel to an Instagram sound (ADR 0019): the sound plays from its
 * start, and it is never rendered into the export.
 */

function clip(id: string, kind: "IMAGE" | "VIDEO", durationMs: number): Clip {
  return {
    id,
    assetId: `asset-${id}`,
    kind,
    sourceStartMs: 0,
    sourceEndMs: durationMs,
    speed: 1,
    volume: 1,
    zoom: 1,
    fit: "cover",
    filter: "none",
    motion: "none",
    transitionIn: "cut",
    pano: null,
    spot: null,
    room: null,
  };
}

const ownSong: Music = { assetId: "song", sourceStartMs: 12_000, volume: 0.8, bpm: 110, beatOffsetMs: 40 };
const instagramSound: Music = { assetId: "ig-copy", sourceStartMs: 0, volume: 0.6, bpm: 120, beatOffsetMs: 250, instagramAudioId: "18000000000000001" };

function reel(music: Music | null): Timeline {
  return setMusic(addClips(emptyTimeline(), [clip("a", "IMAGE", 3000), clip("b", "VIDEO", 4000)]), music);
}

describe("an Instagram sound's start", () => {
  it("is locked to 0 when the music is set", () => {
    const timeline = reel({ ...instagramSound, sourceStartMs: 30_000 });
    expect(timeline.music?.sourceStartMs).toBe(0);
    expect(isInstagramMusic(timeline.music)).toBe(true);
  });

  it("stays at 0 when an edit tries to move it", () => {
    const timeline = reel(instagramSound);
    const moved = setMusic(timeline, { ...timeline.music!, sourceStartMs: 8000 });
    expect(moved.music?.sourceStartMs).toBe(0);
    // Volume still changes: it is the editor preview's.
    expect(setMusic(timeline, { ...timeline.music!, volume: 0.3 }).music?.volume).toBe(0.3);
  });

  it("is 0 in a saved timeline that says otherwise", () => {
    const saved = JSON.parse(JSON.stringify(reel(instagramSound)));
    saved.music.sourceStartMs = 45_000;
    expect(parseTimeline(saved).music?.sourceStartMs).toBe(0);
  });

  it("does not lock your own song, which can start anywhere", () => {
    const timeline = reel(ownSong);
    expect(timeline.music?.sourceStartMs).toBe(12_000);
    expect(isInstagramMusic(timeline.music)).toBe(false);
    // Older timelines have no instagramAudioId at all.
    expect(parseTimeline({ ...timeline, music: { assetId: "song", sourceStartMs: 5000 } }).music?.sourceStartMs).toBe(5000);
  });

  it("still lets cuts snap to its beat", () => {
    const timeline = reel(instagramSound);
    const snapped = snapCutsToBeats(timeline, { "asset-b": 10_000 });
    expect(snapped).not.toBe(timeline);
    // 120 bpm from 250 ms: cuts land on 250 + n × 500.
    const firstCut = snapped.clips[0]!.sourceEndMs;
    expect((firstCut - 250) % 500).toBe(0);
  });
});

describe("the render plan", () => {
  const library = [
    { id: "asset-a", objectKey: "uploads/w/a.jpg", kind: "IMAGE" as const },
    { id: "asset-b", objectKey: "uploads/w/b.mp4", kind: "VIDEO" as const },
    { id: "song", objectKey: "uploads/w/song.mp3", kind: "AUDIO" as const, instagramAudioId: null },
    { id: "ig-copy", objectKey: "uploads/w/instagram-audio/18000000000000001.m4a", kind: "AUDIO" as const, instagramAudioId: "18000000000000001" },
  ];

  it("leaves an Instagram sound out of the render: no music, no file", () => {
    const payload = parseReelExportPayload(JSON.parse(JSON.stringify(buildReelExportPayload(reel(instagramSound), library))));
    // The payload still records it, so the export screen knows the reel's sound...
    expect(payload.assets["ig-copy"]).toMatchObject({ kind: "AUDIO", instagramAudio: true });
    expect(instagramSoundAssetId(payload)).toBe("ig-copy");

    // ...but the renderer never gets it.
    const plan = reelRenderPlan(payload);
    expect(plan.timeline.music).toBeNull();
    expect(Object.keys(plan.assets).sort()).toEqual(["asset-a", "asset-b"]);
    expect(Object.values(plan.assets).some((asset) => asset.kind === "AUDIO")).toBe(false);
    // The clips, and so their own audio, are untouched.
    expect(plan.timeline.clips).toEqual(payload.timeline.clips);
    expect(referencedAssetIds(plan.timeline).every((id) => plan.assets[id])).toBe(true);
  });

  it("leaves it out even when only the asset knows it is Instagram's", () => {
    // A timeline saved without the flag (an older or tampered client) still renders silent.
    const unflagged = reel({ ...instagramSound, instagramAudioId: null });
    const plan = reelRenderPlan(buildReelExportPayload(unflagged, library));
    expect(plan.timeline.music).toBeNull();
    expect(plan.assets["ig-copy"]).toBeUndefined();
  });

  it("leaves it out even when only the timeline says it is Instagram's", () => {
    const payload = buildReelExportPayload(reel(instagramSound), library.map((asset) => ({ ...asset, instagramAudioId: null })));
    const plan = reelRenderPlan(payload);
    expect(plan.timeline.music).toBeNull();
    expect(plan.assets["ig-copy"]).toBeUndefined();
  });

  it("keeps your own song in the render", () => {
    const payload = buildReelExportPayload(reel(ownSong), library);
    expect(instagramSoundAssetId(payload)).toBeNull();
    const plan = reelRenderPlan(payload);
    expect(plan.timeline.music).toEqual(payload.timeline.music);
    expect(plan.assets.song).toEqual({ objectKey: "uploads/w/song.mp3", kind: "AUDIO" });
  });

  it("reads payloads from before the flag existed", () => {
    const old = { timeline: reel(ownSong), assets: { "asset-a": { objectKey: "a.jpg", kind: "IMAGE" }, "asset-b": { objectKey: "b.mp4", kind: "VIDEO" }, song: { objectKey: "s.mp3", kind: "AUDIO" } } };
    const plan = reelRenderPlan(parseReelExportPayload(old));
    expect(plan.timeline.music?.assetId).toBe("song");
    expect(Object.keys(plan.assets).sort()).toEqual(["asset-a", "asset-b", "song"]);
  });
});

describe("the export screen's choice for the reel's sound", () => {
  it("replaces the reel's soundtrack, as by default", () => {
    expect(instagramChoiceForSound({ audioId: "1", title: "Song", artist: "Band" })).toEqual({ audioId: "1", title: "Song", artist: "Band", audioVolume: 100, videoVolume: 0 });
    expect(instagramChoiceForSound({ audioId: "1", title: "Song", artist: "Band" }, null)).toEqual({ audioId: "1", title: "Song", artist: "Band", audioVolume: 100, videoVolume: 0 });
  });

  it("takes the recommended mix when the trace has one, and it survives the post's parsing", () => {
    const choice = instagramChoiceForSound({ audioId: "1018160750329642", title: "Fresh Dance Club (Instrumental)", artist: "Last Jerónimo" }, { audioVolume: 100, videoVolume: 60 });
    expect(choice).toMatchObject({ audioVolume: 100, videoVolume: 60 });
    expect(parseInstagramAudioChoice(choice)).toEqual(choice);
    expect(instagramChoiceForSound({ audioId: "1", title: "Song", artist: null }, { audioVolume: 40.4, videoVolume: 130 })).toMatchObject({ audioVolume: 40, videoVolume: 100 });
  });
});

describe("storing a preview", () => {
  it("keeps Instagram's MP4 previews as MP4 audio, whatever they are labelled", () => {
    expect(instagramPreviewFormat("video/mp4")).toEqual({ extension: "m4a", contentType: "audio/mp4" });
    expect(instagramPreviewFormat("audio/mp4; charset=binary")).toEqual({ extension: "m4a", contentType: "audio/mp4" });
    expect(instagramPreviewFormat(null)).toEqual({ extension: "m4a", contentType: "audio/mp4" });
    expect(instagramPreviewFormat("audio/mpeg")).toEqual({ extension: "mp3", contentType: "audio/mpeg" });
    expect(instagramPreviewFormat("audio/wav")).toEqual({ extension: "wav", contentType: "audio/wav" });
  });

  it("files it under the workspace's uploads with a safe name", () => {
    expect(instagramPreviewKeyFor("ws1", "18000000000000001", "m4a")).toBe("uploads/ws1/instagram-audio/18000000000000001.m4a");
    expect(instagramPreviewKeyFor("ws1", "../../etc/passwd", "m4a")).toBe("uploads/ws1/instagram-audio/etcpasswd.m4a");
  });
});

describe("Play with sound", () => {
  it("leaves the sound alone while it is within 80 ms of the video", () => {
    expect(soundSyncTarget(10, 10.05, 30)).toBeNull();
    expect(soundSyncTarget(10, 9.93, 30)).toBeNull();
  });

  it("pulls the sound back to the video when it drifts further", () => {
    expect(soundSyncTarget(10, 10.2, 30)).toBe(10);
    expect(soundSyncTarget(0, 4, 30)).toBe(0);
  });

  it("lets a shorter sound finish: past its end the reel plays on in silence", () => {
    expect(soundSyncTarget(20, 15, 15)).toBeNull();
    expect(soundSyncTarget(14, 2, 15)).toBe(14);
    // Length not known yet: keep in step.
    expect(soundSyncTarget(14, 2, null)).toBe(14);
  });
});

describe("the pretend Instagram's sound", () => {
  it("is a WAV of clicks whose tempo the editor finds", () => {
    const wav = fakeInstagramSoundWav();
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    expect(wav.byteLength).toBe(44 + FAKE_INSTAGRAM_SOUND.sampleRate * FAKE_INSTAGRAM_SOUND.seconds);

    // Decode the 8-bit PCM the way a browser would, at the detector's rate.
    expect(FAKE_INSTAGRAM_SOUND.sampleRate).toBe(BEAT_SAMPLE_RATE);
    const samples = Float32Array.from(wav.slice(44), (byte) => (byte - 128) / 128);
    const grid = detectBeats(samples);
    expect(grid?.bpm).toBeCloseTo(FAKE_INSTAGRAM_SOUND.bpm, 0);
    expect(Math.abs((grid?.offsetMs ?? 0) - FAKE_INSTAGRAM_SOUND.offsetMs)).toBeLessThan(30);
  });
});
