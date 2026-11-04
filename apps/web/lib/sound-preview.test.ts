import { describe, expect, it, vi } from "vitest";
import { connectSoundPreview } from "./sound-preview";

class Media extends EventTarget {
  paused = true;
  muted = true;
  volume = 1;
  loop = true;
  currentTime = 0;
  duration = 120;
  playbackRate = 1;
  src = "";
  rejectPlay = false;
  play = vi.fn(async () => {
    if (this.rejectPlay) throw Error("play refused");
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  });
  pause = vi.fn(() => {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  });
}
const sound = { audioId: "piano", title: "Piano", artist: null, audioVolume: 80, videoVolume: 35 };
const tick = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
function setup(resolve = vi.fn(async () => ({ ok: true as const, url: "https://private/sound" }))) {
  const video = new Media();
  const audio = new Media();
  const changed = vi.fn();
  const controller = connectSoundPreview(video as unknown as HTMLVideoElement, audio as unknown as HTMLAudioElement, sound, resolve, changed);
  return { video, audio, changed, controller, resolve };
}
describe("selected soundtrack transport", () => {
  it("the main video's native Play loads the selected sound and mixes both volumes", async () => {
    const t = setup();
    await t.video.play(); await tick();
    expect(t.resolve).toHaveBeenCalledOnce();
    expect(t.audio.src).toBe("https://private/sound");
    expect(t.audio.paused).toBe(false);
    expect(t.video.paused).toBe(false);
    expect(t.audio.volume).toBe(.8);
    expect(t.video.volume).toBe(.35);
    expect(t.changed).toHaveBeenLastCalledWith({ state: "playing", error: null });
    t.video.pause();
    expect(t.audio.paused).toBe(true);
    t.controller.dispose();
  });
  it("native seeks, playback speed, replay and a shorter sound never restart the wrong segment", async () => {
    const t = setup(); await t.controller.play();
    t.video.currentTime = 24; t.video.playbackRate = 1.5;
    t.video.dispatchEvent(new Event("seeked"));
    expect(t.audio.currentTime).toBe(24);
    expect(t.audio.playbackRate).toBe(1.5);
    t.video.currentTime = 130; t.video.dispatchEvent(new Event("timeupdate"));
    expect(t.audio.paused).toBe(true);
    t.video.currentTime = 4; t.video.dispatchEvent(new Event("seeked")); await tick();
    expect(t.audio.currentTime).toBe(4);
    expect(t.audio.paused).toBe(false);
    await t.controller.play(true);
    expect(t.video.currentTime).toBe(0);
    expect(t.audio.currentTime).toBe(0);
    t.controller.dispose();
  });
  it("a missing preview or rejected playback pauses BOTH media rather than playing an incorrect export", async () => {
    const t = setup(); t.audio.rejectPlay = true;
    await t.controller.play();
    expect(t.audio.paused).toBe(true);
    expect(t.video.paused).toBe(true);
    expect(t.changed.mock.lastCall?.[0].error).toContain("Nothing is playing");
    t.audio.rejectPlay = false; await t.controller.play();
    t.audio.dispatchEvent(new Event("error"));
    expect(t.audio.paused).toBe(true);
    expect(t.video.paused).toBe(true);
    expect(t.changed.mock.lastCall?.[0].error).toContain("could not load");
    t.controller.dispose();
  });
  it("an old sound resolving after a change cannot start playing", async () => {
    let finish!: (value: { ok: true; url: string }) => void;
    const t = setup(vi.fn(() => new Promise(resolve => { finish = resolve; })));
    const pending = t.controller.play();
    t.controller.dispose();
    finish({ ok: true, url: "old sound" }); await pending;
    expect(t.audio.play).not.toHaveBeenCalled();
    expect(t.video.paused).toBe(true);
    expect(t.video.loop).toBe(true);
  });
});
