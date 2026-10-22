"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { soundSyncTarget, type InstagramAudioChoice } from "@reelwalk/core";
import { instagramSoundPlayback } from "@/app/instagram-audio-actions";
import { PauseIcon, PlayIcon } from "./icons";

/**
 * The export screen's video, shared with "Play with sound" so the finished
 * reel can be watched with the Instagram sound picked for it. Instagram
 * cannot preview a reel with its sound attached (ADR 0018); this plays both
 * here, in step, as Instagram will: the sound from its start with the reel.
 */

type Stage = { video: HTMLVideoElement | null; setVideo(video: HTMLVideoElement | null): void };

const StageContext = createContext<Stage | null>(null);

export function ExportStage({ children }: { children: ReactNode }) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  return <StageContext.Provider value={{ video, setVideo }}>{children}</StageContext.Provider>;
}

/** The rendered reel, muted and looping, as before; "Play with sound" takes it over while it plays. */
export function ExportVideo({ src, originalAudio = false }: { src: string; originalAudio?: boolean }) {
  const stage = useContext(StageContext);
  return <video ref={stage?.setVideo} src={src} controls playsInline autoPlay={!originalAudio} muted={!originalAudio} loop data-testid="export-video" />;
}

type PlayState = "idle" | "loading" | "playing" | "paused";

/**
 * Plays the rendered video with the chosen sound's preview, both from 0 and
 * kept together: play, pause, seek and loop follow the video, and the sound
 * is pulled back whenever it drifts more than 80 ms. The sound comes from the
 * workspace's private copy in storage, never straight from Instagram's CDN.
 * With "keep my reel's own music" the video's sound plays underneath, as
 * Instagram will mix it.
 */
export function PlayWithSound({ sound, label = "Play with sound", hint }: { sound: InstagramAudioChoice; /** The idle button's words ("Mix preview" on the export page's mix strip, ADR 0066). */ label?: string; hint?: string }) {
  const stage = useContext(StageContext);
  const video = stage?.video ?? null;
  const audio = useRef<HTMLAudioElement>(null);
  const urls = useRef(new Map<string, string>());
  const [state, setState] = useState<PlayState>("idle");
  const [error, setError] = useState<string | null>(null);
  const active = state === "playing" || state === "paused";

  const stop = useCallback(() => {
    audio.current?.pause();
    if (video) {
      video.muted = true;
      video.loop = true;
    }
    setState("idle");
  }, [video]);

  // A different sound starts over; nothing keeps playing once this is gone.
  useEffect(() => stop, [sound.audioId, stop]);

  // The mix follows the "keep my reel's own music" choice, even mid-play.
  useEffect(() => {
    if (!active || !video || !audio.current) return;
    audio.current.volume = sound.audioVolume / 100;
    video.muted = sound.videoVolume === 0;
    video.volume = sound.videoVolume / 100;
  }, [active, video, sound.audioVolume, sound.videoVolume]);

  // Keeps the sound with the video while playing with sound.
  useEffect(() => {
    const element = audio.current;
    if (!active || !video || !element) return;
    const duration = () => (Number.isFinite(element.duration) ? element.duration : null);
    const sync = () => {
      const length = duration();
      // Past the end of a shorter sound the reel plays on in silence.
      if (length !== null && video.currentTime >= length) {
        if (!element.paused) element.pause();
        return;
      }
      const target = soundSyncTarget(video.currentTime, element.currentTime, length);
      if (target !== null) element.currentTime = target;
      if (!video.paused && element.paused) element.play().catch(() => undefined);
    };
    const onPlay = () => {
      setState("playing");
      sync();
    };
    const onPause = () => {
      element.pause();
      setState("paused");
    };
    // Loop together: both start again from 0.
    const onEnded = () => {
      video.currentTime = 0;
      element.currentTime = 0;
      video.play().catch(() => undefined);
    };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", sync);
    video.addEventListener("ended", onEnded);
    const timer = setInterval(sync, 250);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", sync);
      video.removeEventListener("ended", onEnded);
      clearInterval(timer);
    };
  }, [active, video]);

  async function start() {
    const element = audio.current;
    if (!video || !element) return;
    setError(null);
    let url = urls.current.get(sound.audioId);
    if (!url) {
      setState("loading");
      const result = await instagramSoundPlayback({ audioId: sound.audioId, title: sound.title, artist: sound.artist }).catch(() => ({
        ok: false as const,
        error: "Could not reach ReelWalk. Try again.",
      }));
      if (!result.ok) {
        setError(result.error);
        setState("idle");
        return;
      }
      url = result.url;
      urls.current.set(sound.audioId, url);
    }
    if (element.dataset.audioId !== sound.audioId) {
      element.src = url;
      element.dataset.audioId = sound.audioId;
    }
    video.pause();
    video.loop = false;
    video.muted = sound.videoVolume === 0;
    video.volume = sound.videoVolume / 100;
    element.volume = sound.audioVolume / 100;
    video.currentTime = 0;
    element.currentTime = 0;
    setState("playing");
    try {
      await Promise.all([video.play(), element.play()]);
    } catch {
      setError("The browser would not play it. Tap Play with sound again.");
    }
  }

  function toggle() {
    if (state === "loading") return;
    if (state === "idle") void start();
    else if (state === "paused") video?.play().catch(() => undefined);
    else video?.pause();
  }

  return (
    <div className="play-with-sound" data-testid="play-with-sound" data-state={state}>
      <button type="button" className="btn btn-quiet btn-block" onClick={toggle} disabled={!video || state === "loading"} data-testid="play-with-sound-button">
        {state === "playing" ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
        {state === "loading" ? "Getting the sound…" : state === "playing" ? "Pause" : state === "paused" ? "Resume with sound" : label}
      </button>
      {active ? (
        <button type="button" className="btn btn-quiet" onClick={stop} data-testid="play-with-sound-stop">
          Stop
        </button>
      ) : null}
      <audio ref={audio} preload="auto" hidden data-testid="play-with-sound-audio" />
      {error ? (
        <p className="error small" role="alert" style={{ gridColumn: "1 / -1" }}>
          {error}
        </p>
      ) : (
        <p className="muted small" style={{ gridColumn: "1 / -1" }}>
          {hint ?? "How the reel will play on Instagram with this sound. Instagram mixes it in when it posts."}
        </p>
      )}
    </div>
  );
}
