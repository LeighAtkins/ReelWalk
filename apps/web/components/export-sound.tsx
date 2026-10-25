"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { instagramAudioLabel, type InstagramAudioChoice } from "@reelwalk/core";
import { instagramSoundPlayback } from "@/app/instagram-audio-actions";
import { connectSoundPreview, type SoundPreviewState } from "@/lib/sound-preview";
import { PauseIcon, PlayIcon } from "./icons";

type Stage = {
  video: HTMLVideoElement | null;
  setVideo(video: HTMLVideoElement | null): void;
  sound: InstagramAudioChoice | null;
  setSound(sound: InstagramAudioChoice | null): void;
  transport: ReturnType<typeof connectSoundPreview> | null;
  playback: SoundPreviewState;
};
const StageContext = createContext<Stage | null>(null);

/** The main video's Play/seek/pause controls and mix buttons share exactly one audio element. */
export function ExportStage({ children }: { children: ReactNode }) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [sound, setSound] = useState<InstagramAudioChoice | null>(null);
  const [transport, setTransport] = useState<ReturnType<typeof connectSoundPreview> | null>(null);
  const [playback, setPlayback] = useState<SoundPreviewState>({ state: "idle", error: null });
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (!video || !audio.current || !sound) { setTransport(null); return; }
    const current = connectSoundPreview(video, audio.current, sound, async () => {
      const result = await instagramSoundPlayback({ audioId: sound.audioId, title: sound.title, artist: sound.artist });
      return result;
    }, setPlayback);
    setTransport(current);
    return () => current.dispose();
  }, [video, sound]);
  return <StageContext.Provider value={{ video, setVideo, sound, setSound, transport, playback }}>
    {children}
    {sound ? <audio ref={audio} preload="auto" hidden data-testid="play-with-sound-audio" /> : null}
  </StageContext.Provider>;
}

/** Registers the saved/draft choice, so even the video's native Play button uses the selected mix. */
export function useStageSound(sound: InstagramAudioChoice | null) {
  const setSound = useContext(StageContext)?.setSound;
  const key = sound ? JSON.stringify(sound) : "null";
  useEffect(() => {
    setSound?.(sound);
    return () => setSound?.(null);
    // Value identity changes on renders; only a changed mix should reset playback.
  }, [setSound, key]);
}

export function ExportVideo({ src }: { src: string }) {
  const stage = useContext(StageContext);
  return <video ref={stage?.setVideo} src={src} controls playsInline autoPlay={false} muted={false} loop data-testid="export-video" />;
}

/** Also used as the prominent transport above the posting actions. A preview is not a server-rendered Instagram post. */
export function PlayWithSound({ sound, label = "Play reel with selected music", hint, testId = "play-with-sound" }: { sound: InstagramAudioChoice; label?: string; hint?: string; testId?: string }) {
  const stage = useContext(StageContext);
  const play = () => { void stage?.transport?.play(true); };
  const state = stage?.playback.state ?? "idle";
  return <div className="play-with-sound" data-testid={testId} data-state={state}>
    <p className="small" style={{ gridColumn: "1 / -1" }}><strong>Preview soundtrack:</strong> {instagramAudioLabel(sound)} · starts at 0:00</p>
    <button type="button" className="btn btn-block" disabled={!stage?.video || state === "loading"} onClick={() => state === "playing" ? stage?.transport?.pause() : state === "paused" ? void stage?.transport?.play() : play()} data-testid={`${testId}-button`}>
      {state === "playing" ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
      {state === "loading" ? "Loading selected music…" : state === "playing" ? "Pause preview" : state === "paused" ? "Resume preview" : label}
    </button>
    {state === "playing" || state === "paused" ? <button type="button" className="btn btn-quiet" onClick={() => stage?.transport?.stop()} data-testid={`${testId}-stop`}>Stop preview</button> : null}
    <button type="button" className="btn btn-quiet" disabled={!stage?.video || state === "loading"} onClick={play}>Replay from beginning</button>
    {stage?.playback.error ? <p className="error small" role="alert" style={{ gridColumn: "1 / -1" }}>{stage.playback.error}</p> : null}
    <p className="muted small" style={{ gridColumn: "1 / -1" }}>{hint ?? "The video controls also play this mix. Listen through the whole reel before posting. This uses Instagram’s audio preview; the downloaded MP4 keeps its original audio."}</p>
    <p className="muted small" style={{ gridColumn: "1 / -1" }}>Need to skip an intro? Instagram auto-posting starts this sound at 0:00. To choose a later start, finish the post in Instagram, or use your own music in the editor → Music → Adjust → Start the song at.</p>
  </div>;
}
