import { soundSyncTarget, type InstagramAudioChoice } from "@reelwalk/core";

export type SoundPreviewState = { state: "idle" | "loading" | "playing" | "paused"; error: string | null };
type SoundResult = { ok: true; url: string } | { ok: false; error: string };

/** One transport for the video controls and every mix-preview button. Never play the wrong track after a failed load. */
export function connectSoundPreview(
  video: HTMLVideoElement,
  audio: HTMLAudioElement,
  sound: InstagramAudioChoice,
  resolve: () => Promise<SoundResult>,
  changed: (value: SoundPreviewState) => void,
) {
  const previous = { muted: video.muted, volume: video.volume, loop: video.loop };
  let generation = 0;
  let disposed = false;
  let starting = false;
  let state: SoundPreviewState["state"] = "idle";
  let url: string | null = null;
  const report = (next: SoundPreviewState["state"], error: string | null = null) => {
    state = next;
    changed({ state, error });
  };
  video.pause();
  video.loop = false;
  video.muted = sound.videoVolume === 0;
  video.volume = sound.videoVolume / 100;
  audio.volume = sound.audioVolume / 100;

  function fail(message: string) {
    url = null;
    starting = true;
    video.pause();
    audio.pause();
    starting = false;
    report("idle", message);
  }

  async function play(restart = false) {
    const request = ++generation;
    starting = true;
    video.pause();
    audio.pause();
    if (restart || video.ended) video.currentTime = 0;
    report("loading");
    try {
      if (!url) {
        const result = await resolve();
        if (disposed || request !== generation) return;
        if (!result.ok) { fail(result.error); return; }
        url = result.url;
        audio.src = url;
      }
      if (disposed || request !== generation) return;
      audio.playbackRate = video.playbackRate;
      audio.currentTime = video.currentTime;
      // The sound may be shorter than the reel. Do not replay its opening.
      if (!Number.isFinite(audio.duration) || video.currentTime < audio.duration) await audio.play();
      if (disposed || request !== generation) return;
      await video.play();
      if (disposed || request !== generation) return;
      starting = false;
      report("playing");
    } catch {
      if (!disposed && request === generation) fail("The selected sound could not play. Nothing is playing. Try again or choose another sound.");
    }
  }

  function pause() {
    ++generation;
    starting = true;
    video.pause();
    audio.pause();
    starting = false;
    report("paused");
  }
  function sync() {
    if (starting || disposed || !url) return;
    const length = Number.isFinite(audio.duration) ? audio.duration : null;
    if (length !== null && video.currentTime >= length) { audio.pause(); return; }
    const target = soundSyncTarget(video.currentTime, audio.currentTime, length);
    if (target !== null) audio.currentTime = target;
    audio.playbackRate = video.playbackRate;
    if (!video.paused && audio.paused) audio.play().catch(() => { if (!disposed) fail("The selected sound stopped. Play again to retry."); });
  }
  const onPlay = () => { if (!starting) void play(); };
  const onPause = () => { if (!starting && state === "playing") pause(); };
  const onError = () => { if (!disposed) { ++generation; fail("The selected sound could not load. Nothing is playing. Try again or choose another sound."); } };
  video.addEventListener("play", onPlay);
  video.addEventListener("pause", onPause);
  video.addEventListener("seeked", sync);
  video.addEventListener("timeupdate", sync);
  video.addEventListener("ratechange", sync);
  audio.addEventListener("error", onError);
  report("idle");
  return {
    play,
    pause,
    stop() { pause(); report("idle"); },
    dispose() {
      disposed = true;
      ++generation;
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", sync);
      video.removeEventListener("timeupdate", sync);
      video.removeEventListener("ratechange", sync);
      audio.removeEventListener("error", onError);
      video.pause();
      audio.pause();
      video.muted = previous.muted;
      video.volume = previous.volume;
      video.loop = previous.loop;
    },
  };
}
