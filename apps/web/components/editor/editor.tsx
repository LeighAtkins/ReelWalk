"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { PlayerRef } from "@remotion/player";
import { setHook, wordsBehindHook, locate,
  addClips,
  insertAiShot,
  luxuryFinish,
  addRoomLabels,
  canWalk,
  hasRoomLabels,
  removeRoomLabels,
  setDetails,
  setPlan,
  snapCutsToBeats,
  addText,
  clipDurationMs,
  clipStartsMs,
  DEFAULT_IMAGE_MS,
  DEFAULT_PANO,
  DEFAULT_PANO_MS,
  duplicateClip,
  instagramAudioLabel,
  instagramIssues,
  moveClip,
  REEL_FORMAT,
  removeClip,
  removeText,
  setMusic,
  splitAt,
  textsAt,
  timelineDurationMs,
  trimClip,
  updateClip,
  updateText,
  type Clip,
  type InstagramAudioTrack,
  type Issue,
  type Plan,
  type Timeline,
  parseTimeline,
  sameTimeline,
  retime,
  retimeToLength,
  setClipRoom,
  setCover,
  setLogo,
  setLook,
  keepTextsClearOfCard,
} from "@reelwalk/core";
import { ELEGANT_FADE_S, type ReelAsset } from "@reelwalk/render/reel";
import { deleteReel, exportReel, readyPreviews, saveCaption } from "@/app/actions";
import { deleteBrief, saveBrief } from "@/app/ai-actions";
import { analyseInstagramSound } from "@/app/instagram-audio-actions";
import { runAiJob } from "@/lib/ai-jobs-client";
import { LookChoices, MusicChoices, ReviewBar, TextChoices, TimingChoices } from "./review";
import { chooseSound } from "@/lib/instagram-sounds-client";
import { formatDuration } from "@/lib/format";
import type { LibraryAsset } from "@/lib/library";
import { takePendingFiles } from "@/lib/pending-files";
import {
  CaptionIcon,
  CheckIcon,
  ClockIcon,
  SparkIcon,
  CloseIcon,
  CoverIcon,
  DetailsIcon,
  DuplicateIcon,
  EditIcon,
  FilterIcon,
  FitIcon,
  AskIcon,
  GuidesIcon,
  LogoIcon,
  MotionIcon,
  ZoomIcon,
  MoveLeftIcon,
  MoveRightIcon,
  MusicIcon,
  PanoIcon,
  PlanIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RedoIcon,
  SpeedIcon,
  SplitIcon,
  SwapIcon,
  TextIcon,
  TransitionIcon,
  TrashIcon,
  TrimIcon,
  UndoIcon,
  VolumeIcon,
} from "../icons";
import { createClock, useClock, type Clock } from "./clock";
import { ClipSourceInfo } from "./clip-source-info";
import { DirectorSheet } from "./director-sheet";
import { Filmstrip, type PendingUpload, type Selection } from "./filmstrip";
import { historyReducer, initHistory } from "./history";
import { HookSheet, PinSheet,
  AskSheet,
  AutopilotSheet,
  type AutopilotInfo,
  type AutopilotPhase,
  type Brief,
  CaptionSheet,
  DetailsSheet,
  ExportSheet,
  LogoSheet,
  LookSheet,
  MediaSheet,
  MotionSheet,
  MusicSheet,
  PanoSheet,
  PlanSheet,
  SpeedSheet,
  TextSheet,
  TimingSheet,
  TransitionSheet,
  TrimSheet,
  VolumeSheet,
  ZoomSheet,
  type InstagramSoundAccess,
  type TextDraft,
} from "./sheets";
import { analyseStoredAudio, uploadFile } from "./upload";
import { useAutosave } from "./use-autosave";
import { AiVideoPanel } from "../ai-video-panel";
import { Sheet } from "./sheets";

// The Player only runs in the browser.
const Preview = dynamic(() => import("./preview").then((module) => module.Preview), {
  ssr: false,
  loading: () => (
    <div className="stage">
      <div className="stage-frame" />
    </div>
  ),
});

type SheetName =
  | "ai-video"
  | "media"
  | "trim"
  | "speed"
  | "volume"
  | "look"
  | "motion"
  | "pano"
  | "plan"
  | "details"
  | "transition"
  | "text-new"
  | "text-edit"
  | "timing"
  | "pin"
  | "music"
  | "zoom"
  | "logo"
  | "hook"
  | "caption"
  | "export"
  | "ask"
  | "director"
  | "autopilot"
  | "review-text"
  | "review-timing"
  | "review-music"
  | "review-look";

export type EditorProps = {
  /** Open the media library straight away (a reel started from the library). */
  openLibrary?: boolean;
  /** Floor plans of the home tours the library media belongs to. */
  tours?: Record<string, { name: string; plan: Plan }>;
  reel: { id: string; title: string; revision: number; caption: string };
  timeline: Timeline;
  library: LibraryAsset[];
  /** Whether "Ask for a change" (ADR 0020) is offered on this deployment. */
  askAvailable?: boolean;
  /** Ways of cutting a whole reel: built-in briefs and the studio's own. */
  briefs?: Brief[];
  /** Opened from "Make it for me": the panel opens at once, and the reel it makes opens in the review. */
  autopilot?: boolean;
  /** Open in the draft review (ADR 0022) rather than the timeline. */
  review?: boolean;
  /** Whether the Music sheet offers Instagram's sounds (null: not on this deployment). */
  instagramSounds?: InstagramSoundAccess;
};

const newId = () => crypto.randomUUID();

/** A reel nobody has cut yet: clips as they were picked, no text, no music. */
function isFresh(timeline: Timeline): boolean {
  return timeline.texts.length === 0 && timeline.music === null && timeline.clips.every((clip) => clip.filter === "none" && clip.transitionIn === "cut" && clip.speed === 1);
}
const toFrame = (ms: number) => Math.round((ms * REEL_FORMAT.fps) / 1000);

function clipFromAsset(asset: LibraryAsset): Clip {
  const isImage = asset.kind === "IMAGE";
  return {
    id: newId(),
    assetId: asset.id,
    kind: isImage ? "IMAGE" : "VIDEO",
    sourceStartMs: 0,
    // Photos get three seconds and 360 photos five; videos play in full (the export check catches anything over 3 minutes).
    sourceEndMs: asset.isPano ? DEFAULT_PANO_MS : isImage ? DEFAULT_IMAGE_MS : Math.max(500, asset.durationMs ?? 5000),
    speed: 1,
    volume: 1,
    zoom: 1,
    fit: "cover",
    filter: "none",
    // A slow push-in is the default for listing photos.
    motion: isImage && !asset.isPano ? "zoom-in" : "none",
    transitionIn: "cut",
    // A 360 photo opens as a camera sweep through the room.
    pano: asset.isPano ? DEFAULT_PANO : null,
    // Tour media knows where it was shot, which drives the floor plan marker.
    spot: asset.spot,
    room: asset.room,
  };
}

function Timecode({ clock, totalMs }: { clock: Clock; totalMs: number }) {
  const now = useClock(clock);
  return (
    <span className="timecode" aria-label="Playhead position">
      {formatDuration(Math.min(now, totalMs), true)} <span className="total">/ {formatDuration(totalMs, true)}</span>
    </span>
  );
}

function Tool({
  label,
  onClick,
  children,
  disabled,
  pressed,
  danger,
}: {
  label: string;
  onClick(): void;
  children: React.ReactNode;
  disabled?: boolean;
  pressed?: boolean;
  danger?: boolean;
}) {
  return (
    <button type="button" className={`tool${danger ? " tool-danger" : ""}`} onClick={onClick} disabled={disabled} aria-pressed={pressed}>
      {children}
      {label}
    </button>
  );
}

export function Editor({ reel, timeline: initialTimeline, library: initialLibrary, openLibrary, tours = {}, instagramSounds = null, askAvailable = false, briefs: initialBriefs = [], autopilot = false, review: startInReview = false }: EditorProps) {
  const [review, setReview] = useState(startInReview);
  const [briefs, setBriefs] = useState<Brief[]>(initialBriefs);
  const [autopilotPhase, setAutopilotPhase] = useState<AutopilotPhase>("form");
  const [autopilotError, setAutopilotError] = useState<{ message: string; upgrade: boolean } | null>(null);
  const autopilotRequest = useRef<{ style: string; info: AutopilotInfo } | null>(null);
  const router = useRouter();
  const [history, dispatch] = useReducer(historyReducer, initialTimeline, initHistory);
  const timeline = history.present;
  const [title, setTitle] = useState(reel.title);
  const [caption, setCaption] = useState(reel.caption);
  const [selection, setSelection] = useState<Selection>(null);
  const [sheet, setSheet] = useState<SheetName | null>(autopilot ? "autopilot" : openLibrary && initialTimeline.clips.length === 0 ? "media" : null);
  const [library, setLibrary] = useState<Record<string, LibraryAsset>>(() => Object.fromEntries(initialLibrary.map((asset) => [asset.id, asset])));
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [musicUploading, setMusicUploading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [guides, setGuides] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [exportState, setExportState] = useState<{ busy: boolean; error: string | null; issues: Issue[] | null; upgrade?: boolean }>({ busy: false, error: null, issues: null });
  const clock = useMemo(() => createClock(), []);
  const [theater, setTheater] = useState(false);
  const exitTheater = useCallback(() => setTheater(false), []);
  const playerRef = useRef<PlayerRef>(null);
  // The Player loads after this component and remounts when the reel goes
  // from empty to non-empty; state makes the event subscription follow it.
  const [player, setPlayer] = useState<PlayerRef | null>(null);
  const attachPlayer = useCallback((instance: PlayerRef | null) => {
    playerRef.current = instance;
    setPlayer(instance);
  }, []);
  const autosave = useAutosave(reel.id, reel.revision, timeline, title);

  const totalMs = timelineDurationMs(timeline);
  const apply = useCallback((update: (timeline: Timeline) => Timeline, key?: string) => dispatch({ type: "apply", update, key }), []);

  const showToast = useCallback((message: string, ms = 2600) => {
    setToast(message);
    setTimeout(() => setToast((current) => (current === message ? null : current)), ms);
  }, []);

  /** A hint shown the first time something comes up on this device, never again. */
  const tipShown = useRef<string | null>(null);
  const tipOnce = useCallback(
    (key: string, message: string) => {
      try {
        if (localStorage.getItem(`reelwalk.tip.${key}`)) return;
        localStorage.setItem(`reelwalk.tip.${key}`, "1");
      } catch {
        return;
      }
      tipShown.current = message;
      showToast(message, 5500);
    },
    [showToast],
  );

  // A tip is about the editor behind it; opening a sheet puts it away.
  useEffect(() => {
    if (sheet && tipShown.current) setToast((current) => (current === tipShown.current ? null : current));
  }, [sheet]);

  // ── Selection (stays valid across undo) ─────────────────────
  const selectedClipIndex = selection?.kind === "clip" ? timeline.clips.findIndex((clip) => clip.id === selection.id) : -1;
  const selectedClip = selectedClipIndex >= 0 ? timeline.clips[selectedClipIndex] : null;
  const selectedText = selection?.kind === "text" ? (timeline.texts.find((text) => text.id === selection.id) ?? null) : null;
  const musicSelected = selection?.kind === "music" && timeline.music !== null;
  const activeSelection: Selection = selectedClip ? selection : selectedText ? selection : musicSelected ? selection : null;

  // First-time hints for the gestures that have no button.
  const selectedKind = activeSelection?.kind;
  useEffect(() => {
    const mouse = window.matchMedia("(pointer: fine)").matches;
    if (selectedKind === "text") tipOnce("text", "Drag the ends of the text bar to set when it shows. Drag the words in the picture to move them.");
    if (selectedKind === "clip") tipOnce("clip", `Drag the clip's red ends to trim it. ${mouse ? "Ctrl + scroll" : "Pinch the timeline"} to zoom in.`);
  }, [selectedKind, tipOnce]);

  // ── Player and playhead ─────────────────────────────────────
  const seek = useCallback(
    (ms: number, source: "seek" | "scrub" = "seek") => {
      const clamped = Math.max(0, Math.min(ms, Math.max(0, totalMs - 1)));
      clock.set(clamped, source);
      playerRef.current?.seekTo(toFrame(clamped));
    },
    [clock, totalMs],
  );

  const hasClips = timeline.clips.length > 0;
  useEffect(() => {
    if (!player) return;
    const onFrame = ({ detail }: { detail: { frame: number } }) => clock.set((detail.frame * 1000) / REEL_FORMAT.fps, "player");
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    player.addEventListener("frameupdate", onFrame);
    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    player.addEventListener("ended", onPause);
    player.seekTo(toFrame(clock.get()));
    return () => {
      player.removeEventListener("frameupdate", onFrame);
      player.removeEventListener("play", onPlay);
      player.removeEventListener("pause", onPause);
      player.removeEventListener("ended", onPause);
    };
  }, [player, clock]);

  // Keep the playhead inside a reel that got shorter.
  useEffect(() => {
    if (clock.get() > totalMs) seek(totalMs);
  }, [totalMs, clock, seek]);

  const togglePlay = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (player.isPlaying()) player.pause();
    else player.play();
  }, []);

  const scrub = useCallback(
    (ms: number) => {
      if (playerRef.current?.isPlaying()) playerRef.current.pause();
      seek(ms, "scrub");
    },
    [seek],
  );

  // ── Uploads ─────────────────────────────────────────────────
  const addFiles = useCallback(
    async (files: File[]) => {
      setSheet((current) => (current === "autopilot" ? current : null));
      const batch = files.map((file) => ({
        key: newId(),
        file,
        name: file.name,
        progress: 0,
        thumbUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      }));
      setUploads((current) => [...current, ...batch.map(({ key, name, progress, thumbUrl }) => ({ key, name, progress, thumbUrl }))]);

      // Two at a time (each shrinks, then uploads; a third does not make the 4K decode any faster), in the order picked.
      const results: (LibraryAsset | null | undefined)[] = new Array(batch.length);
      let committed = 0;
      const commit = () => {
        const ready: LibraryAsset[] = [];
        const done: string[] = [];
        while (committed < batch.length && results[committed] !== undefined) {
          const result = results[committed];
          if (result) ready.push(result);
          done.push(batch[committed].key);
          if (batch[committed].thumbUrl) URL.revokeObjectURL(batch[committed].thumbUrl!);
          committed++;
        }
        if (ready.length > 0) {
          setLibrary((current) => ({ ...current, ...Object.fromEntries(ready.map((asset) => [asset.id, asset])) }));
          apply((current) => addClips(current, ready.map(clipFromAsset)));
        }
        if (done.length > 0) setUploads((current) => current.filter((upload) => !done.includes(upload.key)));
      };

      let next = 0;
      const worker = async () => {
        while (next < batch.length) {
          const index = next++;
          const item = batch[index];
          try {
            results[index] = await uploadFile(item.file, (progress) =>
              setUploads((current) => current.map((upload) => (upload.key === item.key ? { ...upload, progress } : upload))),
            );
          } catch (error) {
            results[index] = null;
            showToast(error instanceof Error ? error.message : `Could not upload ${item.name}.`);
          }
          commit();
        }
      };
      await Promise.all([worker(), worker()]);
    },
    [apply, showToast],
  );

  // Files picked on the home screen arrive with the navigation.
  const pendingTaken = useRef(false);
  useEffect(() => {
    if (pendingTaken.current) return;
    pendingTaken.current = true;
    const files = takePendingFiles(reel.id);
    if (files.length > 0) void addFiles(files);
  }, [reel.id, addFiles]);

  const uploadMusic = useCallback(
    async (file: File) => {
      setMusicUploading(true);
      try {
        const asset = await uploadFile(file, () => undefined);
        if (asset.kind !== "AUDIO") throw new Error(`${file.name} is not an audio file.`);
        setLibrary((current) => ({ ...current, [asset.id]: asset }));
        apply((current) => setMusic(current, { assetId: asset.id, sourceStartMs: 0, volume: 0.8, bpm: asset.bpm, beatOffsetMs: asset.beatOffsetMs }));
        setSelection({ kind: "music" });
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Could not upload the song.");
      } finally {
        setMusicUploading(false);
      }
    },
    [apply, showToast],
  );

  // Editing to an Instagram sound (ADR 0019): the server keeps a private copy
  // of its preview; its length and tempo are found here, like an upload's.
  const [instagramBusy, setInstagramBusy] = useState<string | null>(null);
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const sourceDurations = useCallback(() => Object.fromEntries(Object.values(libraryRef.current).map((entry) => [entry.id, entry.durationMs])), []);
  const pickInstagramSound = useCallback(
    async (track: InstagramAudioTrack): Promise<boolean> => {
      setInstagramBusy(track.id);
      try {
        const result = await chooseSound({ audioId: track.id, type: track.type, title: track.title, artist: track.artist });
        if (!result.ok) {
          showToast(result.error, 5000);
          return false;
        }
        let asset = result.asset;
        // Measured once per copy; a sound chosen again already knows its tempo.
        if (asset.durationMs === null) {
          const analysis = await analyseStoredAudio(asset.url);
          if (analysis.durationMs !== null) {
            asset = { ...asset, durationMs: analysis.durationMs, bpm: analysis.beat?.bpm ?? null, beatOffsetMs: analysis.beat?.offsetMs ?? null };
            void analyseInstagramSound({
              assetId: asset.id,
              durationMs: analysis.durationMs,
              bpm: asset.bpm,
              beatOffsetMs: asset.beatOffsetMs,
              catalogueMs: track.durationMs,
            }).catch(() => undefined);
          }
        }
        const chosen = asset;
        setLibrary((current) => ({ ...current, [chosen.id]: chosen }));
        apply((current) =>
          setMusic(current, {
            assetId: chosen.id,
            sourceStartMs: 0,
            volume: current.music?.volume ?? 0.8,
            bpm: chosen.bpm,
            beatOffsetMs: chosen.beatOffsetMs,
            instagramAudioId: chosen.instagram?.audioId ?? track.id,
          }),
        );
        // The cuts follow the new song's beat straight away, room labels with them.
        if (chosen.bpm) {
          const durations = Object.fromEntries(Object.values(libraryRef.current).map((entry) => [entry.id, entry.durationMs]));
          apply((current) => {
            if (current.clips.length < 2) return current;
            const next = snapCutsToBeats(current, durations);
            return hasRoomLabels(next) ? addRoomLabels(next) : next;
          });
        }
        setSelection({ kind: "music" });
        showToast(`“${track.title}” added${chosen.bpm ? ", cuts on the beat" : ""}.`);
        return true;
      } catch {
        showToast("Could not get that sound from Instagram. Try again.");
        return false;
      } finally {
        setInstagramBusy(null);
      }
    },
    [apply, showToast],
  );

  // ── New version ─────────────────────────────────────────────
  // After a deploy, this page's uploads and exports (server actions) stop
  // working until it reloads. Saving does not depend on them, so once the
  // reel is saved a reload loses nothing: offer one.
  const [updated, setUpdated] = useState(false);
  useEffect(() => {
    let first: string | null = null;
    const check = async () => {
      try {
        const { build } = (await (await fetch("/api/version", { cache: "no-store" })).json()) as { build: string };
        if (first === null) first = build;
        else if (build !== first) setUpdated(true);
      } catch {
        // Offline or restarting; try later.
      }
    };
    void check();
    const timer = setInterval(check, 3 * 60_000);
    const onVisible = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // ── Preview renditions ──────────────────────────────────────
  // A video uploaded in this session plays from the original (often 4K
  // HEVC) until a worker has made its 720p preview, a minute or two later.
  // Check now and then and switch to it, but never mid-playback.
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const pendingIds = useMemo(
    () =>
      Object.values(library)
        .filter((asset) => asset.previewPending)
        .map((asset) => asset.id)
        .sort()
        .join(","),
    [library],
  );
  useEffect(() => {
    if (!pendingIds) return;
    const ids = pendingIds.split(",");
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    let found: { id: string; url: string }[] = [];
    const check = async () => {
      if (found.length === 0) {
        try {
          found = await readyPreviews({ ids });
        } catch {
          found = [];
        }
      }
      if (found.length > 0 && !playingRef.current) {
        const ready = found;
        found = [];
        setLibrary((current) => {
          const next = { ...current };
          for (const { id, url } of ready) if (next[id]) next[id] = { ...next[id], url, previewPending: false };
          return next;
        });
        return;
      }
      // Give up after 20 minutes; the next page load picks it up anyway.
      if (Date.now() - started < 20 * 60_000) timer = setTimeout(check, found.length > 0 ? 1500 : 12_000);
    };
    timer = setTimeout(check, 8000);
    return () => clearTimeout(timer);
  }, [pendingIds]);

  // ── Clip, text and music actions ────────────────────────────
  const split = useCallback(() => {
    const at = clock.get();
    const id = newId();
    const next = splitAt(timeline, at, id);
    if (next === timeline) {
      showToast("Move the playhead at least half a second away from a clip's edge to split it.");
      return;
    }
    apply(() => next);
    setSelection({ kind: "clip", id });
  }, [apply, clock, showToast, timeline]);

  const deleteSelection = useCallback(() => {
    if (!activeSelection) return;
    if (activeSelection.kind === "clip") apply((current) => removeClip(current, activeSelection.id));
    if (activeSelection.kind === "text") apply((current) => removeText(current, activeSelection.id));
    if (activeSelection.kind === "music") apply((current) => setMusic(current, null));
    setSelection(null);
    setSheet(null);
  }, [activeSelection, apply]);

  const saveText = useCallback(
    (draft: TextDraft) => {
      if (sheet === "text-edit" && selectedText) {
        apply((current) => updateText(current, selectedText.id, draft));
      } else {
        const id = newId();
        // Stacked texts start lower, so a second one does not cover the first.
        // Elegant text sits in the middle of the picture, the way the luxury reels place it.
        const elegant = draft.style === "elegant";
        const y = Math.min(elegant ? 0.7 : 0.62, (elegant ? 0.5 : 0.42) +textsAt(timeline, clock.get()).length * 0.1);
        const startMs = clock.get();
        apply((current) => addText(current, { ...draft, id, startMs, x: 0.5, y }));
        setSelection({ kind: "text", id });
        // Park just past the entry animation (pop or slow fade), so the paused preview shows the text fully.
        seek(startMs + (elegant ? ELEGANT_FADE_S * 1000 + 100 : 300));
      }
      setSheet(null);
    },
    [apply, clock, seek, selectedText, sheet, timeline],
  );

  const selectAndShow = useCallback(
    (next: Selection) => {
      setSelection(next);
      if (next?.kind === "text") {
        const text = timeline.texts.find((item) => item.id === next.id);
        // Show it fully: past its 0.1 s pop-in, and inside its time on screen.
        const visibleFrom = text ? Math.min(text.startMs + 300, text.endMs - 1) : 0;
        if (text && (clock.get() < visibleFrom || clock.get() >= text.endMs)) seek(visibleFrom);
      }
    },
    [clock, seek, timeline.texts],
  );

  // A clip tool shows the clip it changes: opening one moves the playhead onto
  // the clip when it was elsewhere. (Not on a plain tap: that would scroll the
  // strip out from under the finger.)
  const selectedClipId = selectedClip?.id;
  useEffect(() => {
    if (!sheet || !selectedClipId || !["trim", "speed", "volume", "look", "motion", "pano", "transition"].includes(sheet)) return;
    const index = timeline.clips.findIndex((clip) => clip.id === selectedClipId);
    const start = clipStartsMs(timeline)[index];
    if (index < 0 || (clock.get() >= start && clock.get() < start + clipDurationMs(timeline.clips[index]))) return;
    playerRef.current?.pause();
    seek(start);
    // Only when the sheet opens, not on every edit made in it.
  }, [sheet, selectedClipId]);

  // ── Export ──────────────────────────────────────────────────
  const openExport = useCallback(async () => {
    playerRef.current?.pause();
    setExportState({ busy: false, error: null, issues: null });
    setSheet("export");
    const saved = await autosave.flush();
    if (!saved) setExportState({ busy: false, error: autosave.message ?? "Save your changes before exporting.", issues: null });
  }, [autosave]);

  const confirmExport = useCallback(async () => {
    setExportState((current) => ({ ...current, busy: true, error: null }));
    if (!(await autosave.flush())) {
      setExportState({ busy: false, error: "Could not save the latest changes, so the export did not start.", issues: null });
      return;
    }
    // On success the action redirects to the export screen.
    const result = await exportReel({ id: reel.id });
    if (result && !result.ok) setExportState({ busy: false, error: result.message ?? null, issues: result.issues, upgrade: result.upgrade });
  }, [autosave, reel.id]);

  // ── Make it for me ──────────────────────────────────────────
  // Runs once the shots are up. A first cut by rule opens in the review within
  // a couple of seconds (ADR 0024); the model's cut follows in the background
  // and replaces it, as one undoable step, unless the studio has started
  // changing things in the meantime.
  const [polishing, setPolishing] = useState(false);
  // Changes the studio makes in the review while the polish is on its way (the sound fetch and beat snap are not theirs).
  const editsSinceDraft = useRef(0);
  const touched = useCallback(() => {
    editsSinceDraft.current += 1;
  }, []);
  useEffect(() => {
    if (autopilotPhase !== "waiting" || uploads.length > 0 || !autopilotRequest.current) return;
    if (timeline.clips.length === 0) {
      setAutopilotPhase("form");
      setAutopilotError({ message: "None of the shots uploaded. Pick them again from the home screen.", upgrade: false });
      return;
    }
    const { style, info } = autopilotRequest.current;
    autopilotRequest.current = null;
    setAutopilotPhase("cutting");
    void (async () => {
      const fail = (message: string, upgrade = false) => {
        setAutopilotPhase("form");
        setAutopilotError({ message, upgrade });
      };
      type Cut = { ok: true; timeline: unknown; note: string; assets?: LibraryAsset[]; instagramPick?: InstagramAudioTrack } | { ok: false; message: string };
      const takeIn = async (data: Cut & { ok: true }) => {
        if (data.assets?.length) setLibrary((current) => ({ ...current, ...Object.fromEntries(data.assets!.map((asset) => [asset.id, asset])) }));
        apply(() => parseTimeline(data.timeline));
        // An Instagram sound is fetched and the cuts snapped to it.
        if (data.instagramPick) await pickInstagramSound(data.instagramPick);
      };
      let quick: Cut;
      try {
        const response = await fetch(`/api/reels/${reel.id}/autopilot`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timeline, style, info, quick: true }) });
        quick = (await response.json()) as Cut;
      } catch {
        return fail("Could not reach ReelWalk. Check the connection and try again.");
      }
      if (!quick.ok) return fail(quick.message);
      await takeIn(quick);
      // A draft, not an export (ADR 0022): it opens in the review, playing with its music;
      // the studio changes what it wants and exports when it is right.
      setAutopilotPhase("form");
      setSheet(null);
      setReview(true);
      editsSinceDraft.current = 0;
      setPolishing(true);
      showToast("Here is a first cut. ReelWalk is polishing it; play it meanwhile.", 6000);
      try {
        const polished = await runAiJob<Cut>(`/api/reels/${reel.id}/autopilot`, { timeline, style, info });
        // The first cut, its sound and the polish count as the draft; anything else is the studio's.
        if (!polished.ok) showToast(`The first cut stays: ${polished.message}`, 6000);
        else if (editsSinceDraft.current > 0) showToast("You started changing the first cut, so it stays as it is.", 6000);
        else {
          await takeIn(polished);
          showToast("Polished: order, cut and text by ReelWalk. Undo brings the first cut back.", 7000);
        }
      } catch {
        showToast("The first cut stays; the polish could not reach ReelWalk.", 6000);
      } finally {
        setPolishing(false);
      }
    })();
  }, [autopilotPhase, uploads.length, timeline, reel.id, apply, showToast, pickInstagramSound]);

  // Rooms named as soon as the shots are up, so they show (and can be changed) before the reel is made.
  const roomsAsked = useRef(new Set<string>());
  const [naming, setNaming] = useState(0);
  useEffect(() => {
    // Named as each shot lands, while the others are still uploading (ADR 0024).
    if (sheet !== "autopilot") return;
    const ids = [...new Set(timeline.clips.filter((clip) => !clip.room && !roomsAsked.current.has(clip.assetId)).map((clip) => clip.assetId))];
    if (ids.length === 0) return;
    ids.forEach((id) => roomsAsked.current.add(id));
    setNaming((count) => count + 1);
    void fetch(`/api/reels/${reel.id}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assetIds: ids }) })
      .then((response) => response.json() as Promise<{ ok: boolean; rooms?: Record<string, string> }>)
      .then((result) => {
        const rooms = result.rooms ?? {};
        if (Object.keys(rooms).length === 0) return;
        apply((current) => ({ ...current, clips: current.clips.map((clip) => (clip.room || !rooms[clip.assetId] ? clip : { ...clip, room: rooms[clip.assetId] })) }));
      })
      .catch(() => undefined)
      // A shot the AI could not name (a black frame, a blur) is offered for naming by hand.
      .finally(() => setNaming((count) => count - 1));
  }, [sheet, timeline.clips, reel.id, apply]);

  const close = useCallback(async () => {
    await autosave.flush();
    router.push("/");
  }, [autosave, router]);

  // ── Keyboard (desktop) ──────────────────────────────────────
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (sheet || target.closest("input, textarea, [contenteditable]")) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? "redo" : "undo" });
      } else if (event.key === " " && !target.closest("button")) {
        event.preventDefault();
        togglePlay();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        deleteSelection();
      } else if (event.key.toLowerCase() === "s" && !mod) {
        split();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        // A frame at a time, or a second with Shift.
        event.preventDefault();
        playerRef.current?.pause();
        const step = event.shiftKey ? 1000 : 1000 / REEL_FORMAT.fps;
        seek(clock.get() + (event.key === "ArrowLeft" ? -step : step));
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        seek(event.key === "Home" ? 0 : totalMs);
      } else if (event.key === "Escape" && activeSelection) {
        setSelection(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [activeSelection, clock, deleteSelection, seek, sheet, split, togglePlay, totalMs]);

  const assets = useMemo<Record<string, ReelAsset>>(
    () => Object.fromEntries(Object.values(library).map((asset) => [asset.id, { src: asset.url, kind: asset.kind, transcript: asset.transcript }])),
    [library],
  );
  // Media the preview keeps in memory: the clips' preview renditions and the
  // song, in reel order. Originals still waiting for a preview are left out;
  // they can be hundreds of megabytes.
  const prefetchSrcs = useMemo(() => {
    const ids = [...timeline.clips.map((clip) => clip.assetId), ...(timeline.music ? [timeline.music.assetId] : [])];
    const srcs = ids
      .map((id) => library[id])
      .filter((asset) => asset && (asset.kind === "VIDEO" || asset.kind === "AUDIO") && !asset.previewPending)
      .map((asset) => asset!.url);
    return [...new Set(srcs)];
  }, [timeline.clips, timeline.music, library]);
  const issues = useMemo(() => exportState.issues ?? instagramIssues(timeline, caption), [exportState.issues, timeline, caption]);
  const libraryList = useMemo(() => Object.values(library), [library]);
  const musicInstagram = timeline.music ? (library[timeline.music.assetId]?.instagram ?? null) : null;

  const saveLabel = {
    saved: "Saved",
    unsaved: "Editing…",
    saving: "Saving…",
    error: "Not saved",
    conflict: "Not saved",
  }[autosave.status];

  // ── Toolbars ────────────────────────────────────────────────
  let tools: React.ReactNode;
  // With something selected, Done stays at the left and Delete at the right;
  // only the tools between them scroll.
  const selectionLead = activeSelection ? (
    <Tool label="Done" onClick={() => setSelection(null)}>
      <CheckIcon />
    </Tool>
  ) : null;
  const selectionTail = activeSelection ? (
    <Tool label={activeSelection.kind === "music" ? "Remove" : "Delete"} danger onClick={deleteSelection}>
      <TrashIcon />
    </Tool>
  ) : null;
  if (selectedClip) {
    const index = selectedClipIndex;
    const isVideo = selectedClip.kind === "VIDEO";
    tools = (
      <>
        <Tool label="Split" onClick={split}>
          <SplitIcon />
        </Tool>
        <Tool label={isVideo ? "Trim" : "Length"} onClick={() => setSheet("trim")}>
          {isVideo ? <TrimIcon /> : <ClockIcon />}
        </Tool>
        {isVideo ? (
          <>
            <Tool label="Speed" onClick={() => setSheet("speed")}>
              <SpeedIcon />
            </Tool>
            <Tool label="Volume" onClick={() => setSheet("volume")}>
              <VolumeIcon />
            </Tool>
            <Tool label="Motion" onClick={() => setSheet("motion")}><MotionIcon /></Tool>
          </>
        ) : (
          <>
            {library[selectedClip.assetId]?.isPano || selectedClip.pano ? (
              <Tool label="360 view" onClick={() => setSheet("pano")}>
                <PanoIcon />
              </Tool>
            ) : null}
            {!selectedClip.pano ? (
              <Tool label="Motion" onClick={() => setSheet("motion")}>
                <MotionIcon />
              </Tool>
            ) : null}
          </>
        )}
        <Tool label="Look" onClick={() => setSheet("look")}>
          <FilterIcon />
        </Tool>
        <Tool label="Zoom" onClick={() => setSheet("zoom")}>
          <ZoomIcon />
        </Tool>
        <Tool
          label="Cover"
          pressed={timeline.cover?.clipId === selectedClip.id}
          onClick={() => {
            // The frame under the playhead, inside this clip, is the cover Instagram shows; pressing again lets it go.
            if (timeline.cover?.clipId === selectedClip.id) {
              apply((current) => setCover(current, null));
              showToast("The cover is the usual frame again.");
              return;
            }
            const start = clipStartsMs(timeline)[index];
            const offsetMs = Math.max(0, Math.min(clock.get() - start, clipDurationMs(selectedClip) - 100));
            apply((current) => setCover(current, { clipId: selectedClip.id, offsetMs }));
            showToast("This frame is the cover Instagram shows.");
          }}
        >
          <CoverIcon />
        </Tool>
        <Tool
          label={selectedClip.fit === "cover" ? "Fit" : "Fill"}
          onClick={() => apply((current) => updateClip(current, selectedClip.id, { fit: selectedClip.fit === "cover" ? "contain" : "cover" }))}
        >
          <FitIcon />
        </Tool>
        <Tool label="Transition" disabled={index === 0} onClick={() => setSheet("transition")}>
          <TransitionIcon />
        </Tool>
        <Tool label="Duplicate" onClick={() => apply((current) => duplicateClip(current, selectedClip.id, newId()))}>
          <DuplicateIcon />
        </Tool>
        <Tool label="Earlier" disabled={index === 0} onClick={() => apply((current) => moveClip(current, selectedClip.id, index - 1))}>
          <MoveLeftIcon />
        </Tool>
        <Tool label="Later" disabled={index === timeline.clips.length - 1} onClick={() => apply((current) => moveClip(current, selectedClip.id, index + 1))}>
          <MoveRightIcon />
        </Tool>
      </>
    );
  } else if (selectedText) {
    tools = (
      <>
        <Tool label="Edit" onClick={() => setSheet("text-edit")}>
          <EditIcon />
        </Tool>
        <Tool label="Timing" onClick={() => setSheet("timing")}>
          <ClockIcon />
        </Tool>
        <Tool label="Pin" pressed={Boolean(selectedText.path && selectedText.path.length > 2)} onClick={() => setSheet("pin")}>
          <MotionIcon />
        </Tool>
        <Tool label="Guides" pressed={guides} onClick={() => setGuides(!guides)}>
          <GuidesIcon />
        </Tool>
      </>
    );
  } else if (musicSelected) {
    tools = (
      <>
        <Tool label="Adjust" onClick={() => setSheet("music")}>
          <VolumeIcon />
        </Tool>
        <Tool label="Replace" onClick={() => setSheet("music")}>
          <SwapIcon />
        </Tool>
      </>
    );
  } else {
    tools = (
      <>
        <Tool label="Add media" onClick={() => setSheet("media")}>
          <PlusIcon />
        </Tool>
        <Tool label="AI video" onClick={() => setSheet("ai-video")}>
          <MotionIcon />
        </Tool>
        <Tool label="Text" disabled={!hasClips} onClick={() => setSheet("text-new")}>
          <TextIcon />
        </Tool>
        <Tool label="Music" disabled={!hasClips} onClick={() => setSheet("music")}>
          <MusicIcon />
        </Tool>
        {askAvailable ? (
          <Tool label="Ask" disabled={!hasClips} onClick={() => setSheet("ask")}>
            <AskIcon />
          </Tool>
        ) : null}
        <Tool label="Split" disabled={!hasClips} onClick={split}>
          <SplitIcon />
        </Tool>
        {timeline.plan ? (
          <Tool label="Floor plan" onClick={() => setSheet("plan")}>
            <PlanIcon />
          </Tool>
        ) : null}
        <Tool label="Details" onClick={() => setSheet("details")}>
          <DetailsIcon />
        </Tool>
        <Tool label="Hook" disabled={!hasClips} pressed={timeline.hook !== null || timeline.texts.some((t) => t.id.startsWith("hook-word-"))} onClick={() => setSheet("hook")}>
          <SparkIcon />
        </Tool>
        <Tool label="Logo" disabled={!hasClips} pressed={timeline.logo !== null} onClick={() => setSheet("logo")}>
          <LogoIcon />
        </Tool>
        <Tool label="Caption" onClick={() => setSheet("caption")}>
          <CaptionIcon />
        </Tool>
        <Tool label="Guides" pressed={guides} onClick={() => setGuides(!guides)}>
          <GuidesIcon />
        </Tool>
        <Tool
          label="Delete reel"
          danger
          onClick={async () => {
            if (!window.confirm(`Delete "${title}"? Its exports are deleted too. Uploaded media stays in your library.`)) return;
            const form = new FormData();
            form.set("id", reel.id);
            await deleteReel(form);
          }}
        >
          <TrashIcon />
        </Tool>
      </>
    );
  }

  const closeSheet = () => setSheet(null);

  // When the tools run past the edge, a fade on that side says there are more.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const markToolbar = useCallback(() => {
    const element = toolbarRef.current;
    if (!element) return;
    element.dataset.moreRight = String(element.scrollLeft + element.clientWidth < element.scrollWidth - 4);
    element.dataset.moreLeft = String(element.scrollLeft > 4);
  }, []);
  useEffect(() => {
    const element = toolbarRef.current;
    if (!element) return;
    element.scrollLeft = 0;
    markToolbar();
    const observer = new ResizeObserver(markToolbar);
    observer.observe(element);
    return () => observer.disconnect();
  }, [selectedKind, selectedClip?.kind, markToolbar]);

  return (
    <div className="editor" data-testid="editor" data-review={review || undefined}>
      <header className="editor-top">
        <button type="button" className="icon-btn" aria-label="Close editor" onClick={close}>
          <CloseIcon />
        </button>
        <div style={{ minWidth: 0 }}>
          <input
            className="title-input"
            value={title}
            maxLength={80}
            aria-label="Reel title"
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => !title.trim() && setTitle(reel.title)}
          />
          <span className="save-state" role="status" data-testid="save-state" data-status={autosave.status}>
            {saveLabel}
          </span>
        </div>
        <button type="button" className="btn btn-signal" onClick={openExport} disabled={!hasClips} data-testid="export-button">
          Export
        </button>
      </header>

      {autosave.status === "conflict" ? (
        <div className="banner" role="alert" data-testid="conflict-banner">
          <span>{autosave.message}</span>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      ) : null}

      <Preview
        timeline={timeline}
        assets={assets}
        prefetchSrcs={prefetchSrcs}
        playerRef={attachPlayer}
        playing={playing}
        guides={guides}
        selectedText={selectedText}
        onTogglePlay={togglePlay}
        clock={clock}
        onMoveText={(id, x, y, gesture) => apply((current) => updateText(current, id, { x, y }), gesture)}
        onSurfaceText={(id, quad, gesture) => apply((current) => updateText(current, id, { surface: quad }), gesture)}
        onResizeText={(id, size, gesture) => apply((current) => updateText(current, id, { size }), gesture)}
        onSelectText={(id) => setSelection({ kind: "text", id })}
        onEditText={(id) => {
          setSelection({ kind: "text", id });
          setSheet("text-edit");
        }}
        theater={theater}
        onExitTheater={exitTheater}
        empty={
          uploads.length > 0 ? (
            <p>Uploading {uploads.length === 1 ? "1 file" : `${uploads.length} files`}…</p>
          ) : (
            <>
              <p>
                <strong>Start with your listing&apos;s photos and videos.</strong>
              </p>
              <p className="muted small">They play in the order you pick them. Vertical video fills the frame best.</p>
              <button type="button" className="btn" onClick={() => setSheet("media")}>
                <PlusIcon size={18} />
                Add media
              </button>
            </>
          )
        }
      />

      {review ? (
        <ReviewBar
          timeline={timeline}
          polishing={polishing}
          onChange={(change) => {
            playerRef.current?.pause();
            setSheet(change === "ask" ? "ask" : (`review-${change}` as SheetName));
          }}
          onFullEditor={() => setReview(false)}
        />
      ) : null}

      {review ? null : (
      <>
      <div>
      <div className="transport">
        <button type="button" className="icon-btn" aria-label={playing ? "Pause" : "Play"} onClick={togglePlay} disabled={!hasClips}>
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <Timecode clock={clock} totalMs={totalMs} />
        <button type="button" className="icon-btn" aria-label="Undo" disabled={history.past.length === 0} onClick={() => dispatch({ type: "undo" })}>
          <UndoIcon />
        </button>
        <button type="button" className="icon-btn" aria-label="Redo" disabled={history.future.length === 0} onClick={() => dispatch({ type: "redo" })}>
          <RedoIcon />
        </button>
        <button type="button" className="icon-btn" aria-label="Full screen" disabled={!hasClips} onClick={() => setTheater(true)} data-testid="preview-fullscreen">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </svg>
        </button>
      </div>

      {selectedClip ? <ClipSourceInfo clip={selectedClip} asset={library[selectedClip.assetId]} onTrim={() => setSheet("trim")} /> : null}
      </div>
      <Filmstrip
        timeline={timeline}
        library={library}
        uploads={uploads}
        selection={activeSelection}
        clock={clock}
        onSelect={selectAndShow}
        onOpen={(next) => {
          selectAndShow(next);
          if (next?.kind === "text") setSheet("text-edit");
          if (next?.kind === "clip") setSheet("trim");
        }}
        onSeek={(ms) => {
          playerRef.current?.pause();
          seek(ms);
        }}
        onGrab={setSelection}
        onScrub={scrub}
        onTextTiming={(id, timing, gesture) => apply((current) => updateText(current, id, timing), gesture)}
        onMoveClip={(id, toIndex) => apply((current) => moveClip(current, id, toIndex))}
        onClipTrim={(id, window, gesture) =>
          apply((current) => {
            const clip = current.clips.find((item) => item.id === id);
            return clip ? trimClip(current, id, window, library[clip.assetId]?.durationMs ?? undefined) : current;
          }, gesture)
        }
        onAddMedia={() => setSheet("media")}
        onAddText={() => setSheet("text-new")}
        onAddMusic={() => setSheet("music")}
      />

      <nav className="toolbar" aria-label="Editing tools">
        {selectionLead ? <span className="toolbar-context">{selectionLead}</span> : null}
        <div className="toolbar-scroll" ref={toolbarRef} onScroll={markToolbar}>
          {tools}
        </div>
        {selectionTail ? <span className="toolbar-end">{selectionTail}</span> : null}
      </nav>
      </>
      )}

      {updated && !sheet ? (
        <div className="update-notice" role="status">
          <span>ReelWalk was updated.</span>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              if (await autosave.flush()) window.location.reload();
            }}
          >
            Reload
          </button>
        </div>
      ) : null}

      {toast ? (
        <p className="toast" role="status">
          {toast}
        </p>
      ) : null}

      {sheet === "ai-video" ? <Sheet title="AI video" onClose={closeSheet}>
        <AiVideoPanel photos={libraryList} clips={timeline.clips} selectedClip={selectedClip} reelId={reel.id} beforeGenerate={autosave.flush} onAdd={(asset, shot) => {
          const clip = { ...clipFromAsset(asset), id: `ai-insert-${asset.id}` };
          if (shot && insertAiShot(timeline, clip, shot) === timeline) {
            showToast("The source cut changed or this shot is already placed. Add the saved clip from Media to choose a new position.", 6000);
            return;
          }
          setLibrary(current => ({ ...current, [asset.id]: asset }));
          apply(current => shot ? insertAiShot(current, clip, shot) : addClips(current, [clip]));
          setSheet(null);
        }} />
      </Sheet> : null}

      {sheet === "media" ? (
        <MediaSheet
          library={libraryList}
          onUpload={addFiles}
          onPick={(picked) => {
            apply((current) => {
              const next = addClips(current, picked.map(clipFromAsset));
              // The first shot from a home tour brings that home's floor plan with it.
              const tour = picked.map((asset) => (asset.tourId ? tours[asset.tourId] : undefined)).find(Boolean);
              return !next.plan && tour ? setPlan(next, { geometry: tour.plan, corner: "top-left", visible: true }) : next;
            });
            setSheet(null);
          }}
          onClose={closeSheet}
        />
      ) : null}

      {sheet === "trim" && selectedClip ? (
        <TrimSheet
          clip={selectedClip}
          asset={library[selectedClip.assetId]}
          next={timeline.clips[selectedClipIndex + 1] ? { clip: timeline.clips[selectedClipIndex + 1], asset: library[timeline.clips[selectedClipIndex + 1].assetId] } : null}
          onChange={(window) => {
            apply((current) => trimClip(current, selectedClip.id, window, library[selectedClip.assetId]?.durationMs ?? undefined), `trim-${selectedClip.id}`);
          }}
          onClose={closeSheet}
        />
      ) : null}
      {sheet === "speed" && selectedClip ? (
        <SpeedSheet clip={selectedClip} onChange={(speed) => apply((current) => updateClip(current, selectedClip.id, { speed }))} onClose={closeSheet} />
      ) : null}
      {sheet === "volume" && selectedClip ? (
        <VolumeSheet
          title="Clip volume"
          value={selectedClip.volume}
          onChange={(volume) => apply((current) => updateClip(current, selectedClip.id, { volume }), `volume-${selectedClip.id}`)}
          onClose={closeSheet}
        />
      ) : null}
      {sheet === "look" && selectedClip ? (
        <LookSheet
          clip={selectedClip}
          asset={library[selectedClip.assetId]}
          onChange={(filter) => apply((current) => updateClip(current, selectedClip.id, { filter }))}
          onLens={lensSoftness => apply(current => updateClip(current, selectedClip.id, { lensSoftness }), `lens-${selectedClip.id}`)}
          onLuxury={variant => { apply(current => luxuryFinish(current, variant)); showToast("Luxury finish applied. Adjust type and camera moves, or Undo."); }}
          onApplyAll={() => {
            apply((current) => current.clips.reduce((next, clip) => updateClip(next, clip.id, { filter: selectedClip.filter }), current));
            showToast("Applied to every clip.");
          }}
          onClose={closeSheet}
        />
      ) : null}
      {sheet === "pano" && selectedClip ? (
        <PanoSheet
          clip={selectedClip}
          onChange={(pano) =>
            apply(
              (current) => updateClip(current, selectedClip.id, { pano, ...(pano ? { motion: "none" as const } : {}) }),
              `pano-${selectedClip.id}`,
            )
          }
          onPreview={() => {
            setSheet(null);
            seek(clipStartsMs(timeline)[selectedClipIndex] ?? 0);
            playerRef.current?.play();
          }}
          onClose={closeSheet}
        />
      ) : null}
      {sheet === "motion" && selectedClip ? (
        <MotionSheet clip={selectedClip} onChange={(motion) => apply((current) => updateClip(current, selectedClip.id, { motion }))} onClose={closeSheet} />
      ) : null}
      {sheet === "transition" && selectedClip ? (
        <TransitionSheet
          clip={selectedClip}
          canWalkHere={canWalk(timeline.clips[timeline.clips.indexOf(selectedClip) - 1], selectedClip)}
          onChange={(transitionIn) => apply((current) => updateClip(current, selectedClip.id, { transitionIn }))}
          onDirection={whipDirection => apply(current => updateClip(current, selectedClip.id, { whipDirection }))}
          onClose={closeSheet}
        />
      ) : null}

      {sheet === "text-new" ? <TextSheet initial={null} onSave={saveText} onClose={closeSheet} /> : null}
      {sheet === "text-edit" && selectedText ? <TextSheet initial={selectedText} onSave={saveText} onClose={closeSheet} /> : null}
      {sheet === "pin" && selectedText ? (() => {
        const at = locate(timeline, selectedText.startMs);
        const clip = at ? timeline.clips[at.index] : null;
        return <PinSheet text={selectedText} clip={clip} asset={clip ? library[clip.assetId] : undefined} clipStartMs={at ? selectedText.startMs - at.offsetMs : 0}
          onPath={(pinned, patch) => apply((current) => updateText(current, selectedText.id, { path: pinned?.path, pin: pinned?.pin, ...(patch ?? {}) }), `pin-${selectedText.id}`)}
          onSurface={(surface) => apply((current) => updateText(current, selectedText.id, { surface, path: undefined, pin: undefined }), `surface-${selectedText.id}`)} onClose={closeSheet} />;
      })() : null}
      {sheet === "timing" && selectedText ? (
        <TimingSheet
          text={selectedText}
          totalMs={totalMs}
          playheadMs={clock.get()}
          onChange={(timing) => apply((current) => updateText(current, selectedText.id, timing), `timing-${selectedText.id}`)}
          onClose={closeSheet}
        />
      ) : null}

      {sheet === "music" ? (
        <MusicSheet
          library={libraryList}
          music={timeline.music}
          uploading={musicUploading}
          instagram={instagramSounds}
          instagramBusyId={instagramBusy}
          onPickInstagram={pickInstagramSound}
          onPick={(asset) =>
            apply((current) =>
              setMusic(current, { assetId: asset.id, sourceStartMs: 0, volume: current.music?.volume ?? 0.8, bpm: asset.bpm, beatOffsetMs: asset.beatOffsetMs }),
            )
          }
          onSnap={() => {
            const durations = Object.fromEntries(Object.values(library).map((asset) => [asset.id, asset.durationMs]));
            const next = snapCutsToBeats(timeline, durations);
            // Room names follow their clips to the new cut points.
            apply(() => (hasRoomLabels(next) ? addRoomLabels(next) : next));
            showToast("Cuts moved onto the beat.");
            setSheet(null);
          }}
          onUpload={uploadMusic}
          onChange={(patch) => apply((current) => (current.music ? setMusic(current, { ...current.music, ...patch }) : current), "music")}
          onRemove={deleteSelection}
          onClose={closeSheet}
        />
      ) : null}

      {sheet === "plan" && timeline.plan ? (
        <PlanSheet
          overlay={timeline.plan}
          located={timeline.clips.filter((clip) => clip.spot).length}
          total={timeline.clips.length}
          roomLabels={hasRoomLabels(timeline)}
          canLabel={timeline.clips.some((clip) => clip.room)}
          onChange={(patch) => apply((current) => (current.plan ? setPlan(current, { ...current.plan, ...patch }) : current))}
          onRoomLabels={(on) => apply((current) => (on ? addRoomLabels(current) : removeRoomLabels(current)))}
          onRemove={() => {
            apply((current) => setPlan(current, null));
            setSheet(null);
          }}
          onClose={closeSheet}
        />
      ) : null}

      {sheet === "details" ? (
        <DetailsSheet
          reelId={reel.id}
          details={timeline.details}
          onChange={(details) => apply((current) => keepTextsClearOfCard(setDetails(current, details)), "details")}
          onCaption={(text) => {
            setCaption(text);
            showToast("Caption written from the details.");
          }}
          onClose={closeSheet}
        />
      ) : null}

      {sheet === "caption" ? <CaptionSheet reelId={reel.id} caption={caption} askAvailable={askAvailable} onClose={closeSheet} onChange={setCaption} /> : null}
      {sheet === "zoom" && selectedClip ? (
        <ZoomSheet clip={selectedClip} onChange={(zoom) => apply((current) => updateClip(current, selectedClip.id, { zoom }), `zoom-${selectedClip.id}`)} onClose={closeSheet} />
      ) : null}
      {sheet === "hook" ? (
        <HookSheet
          hook={timeline.hook}
          hasPerson={Boolean(timeline.clips[0] && library[timeline.clips[0].assetId]?.isAiGenerated)}
          onChange={(hook) => apply((current) => setHook(current, hook), "hook")}
          onWords={(words, color) => apply((current) => wordsBehindHook(current, words, { color }), "hook-words")}
          onClose={closeSheet}
        />
      ) : null}
      {sheet === "logo" ? (
        <LogoSheet
          library={libraryList}
          logo={timeline.logo}
          onChange={(logo) => apply((current) => setLogo(current, logo), "logo")}
          onUpload={async (file) => {
            const asset = await uploadFile(file, () => undefined);
            setLibrary((current) => ({ ...current, [asset.id]: asset }));
            return asset;
          }}
          onClose={closeSheet}
        />
      ) : null}

      {sheet === "ask" ? (
        <AskSheet
          onDirector={() => setSheet("director")}
          briefs={briefs}
          fresh={isFresh(timeline)}
          onAsk={async (request, answers) => {
            touched();
            // The editor's own copy of the timeline goes along, so unsaved work counts.
            const data = await runAiJob<
              | { ok: true; timeline: unknown; note: string; applied: string[]; skipped: string[]; questions: string[]; assets?: LibraryAsset[]; instagramPick?: InstagramAudioTrack; caption?: string }
              | { ok: false; message: string; upgrade?: boolean }
            >(`/api/reels/${reel.id}/ai-edit`, { request, timeline, answers });
            if (!data.ok) return data;
            // A song or shot the AI brought in joins the library first, so the preview can play it.
            if (data.assets?.length) setLibrary((current) => ({ ...current, ...Object.fromEntries(data.assets!.map((asset) => [asset.id, asset])) }));
            // A caption written for the post is kept with the reel (it is not part of the edit).
            if (data.caption) {
              setCaption(data.caption);
              void saveCaption({ id: reel.id, caption: data.caption }).catch(() => undefined);
            }
            if (data.applied.length > 0) {
              const next = parseTimeline(data.timeline);
              apply(() => next);
              showToast(data.note, 6000);
              setSheet(null);
              if (data.instagramPick) await pickInstagramSound(data.instagramPick);
            }
            return { ok: true, note: data.note, applied: data.applied, skipped: data.skipped, questions: data.questions ?? [] };
          }}
          onSaveBrief={async (name, text) => {
            const result = await saveBrief({ name, text });
            if (result.ok) setBriefs((current) => [...current, { ...result.brief, own: true }]);
            return result;
          }}
          onDeleteBrief={async (id) => {
            await deleteBrief({ id });
            setBriefs((current) => current.filter((brief) => brief.id !== id));
          }}
          onClose={closeSheet}
        />
      ) : null}

      {sheet === "director" ? <DirectorSheet reelId={reel.id} timeline={timeline} library={libraryList} onClose={closeSheet} onAssets={(assets) => setLibrary((current) => ({ ...current, ...Object.fromEntries(assets.map((asset) => [asset.id, asset])) }))} onApply={(review) => {
        if (!sameTimeline(timeline, review.baseline)) return false;
        // The plan may have chosen an Instagram sound; like the ask flow, the editor imports it so the reel actually has music.
        if (review.instagramPick) void pickInstagramSound(review.instagramPick);
        if (review.assets.length) setLibrary(current => ({ ...current, ...Object.fromEntries(review.assets.map(asset => [asset.id, asset])) }));
        apply(() => parseTimeline(review.timeline));
        if (review.plan.edit.caption) {
          setCaption(review.plan.edit.caption);
          void saveCaption({ id: reel.id, caption: review.plan.edit.caption }).catch(() => undefined);
        }
        showToast("Applied Opus's proposed edit. Undo takes it back.");
        return true;
      }} /> : null}

      {sheet === "review-timing" ? (
        <TimingChoices
          timeline={timeline}
          onPace={(shotMs) => {
            touched();
            apply((current) => retime(current, shotMs, sourceDurations()));
          }}
          onLength={(totalMs) => {
            touched();
            apply((current) => retimeToLength(current, totalMs, sourceDurations()));
          }}
          onClose={closeSheet}
        />
      ) : null}
      {sheet === "review-look" ? (
        <LookChoices
          timeline={timeline}
          onLook={(filter) => {
            touched();
            apply((current) => setLook(current, filter));
          }}
          onClose={closeSheet}
        />
      ) : null}
      {sheet === "review-text" ? (
        <TextChoices
          reelId={reel.id}
          texts={timeline.texts}
          roomLabels={hasRoomLabels(timeline)}
          canLabel={timeline.clips.some((clip) => clip.room)}
          onText={(id, text) => {
            touched();
            apply((current) => updateText(current, id, { text }));
            showToast("Text changed.");
          }}
          onRoomLabels={(on) => {
            touched();
            apply((current) => (on ? addRoomLabels(current) : removeRoomLabels(current)));
          }}
          onClose={closeSheet}
        />
      ) : null}
      {sheet === "review-music" ? (
        <MusicChoices
          reelId={reel.id}
          currentAudioId={timeline.music?.instagramAudioId ?? null}
          busyId={instagramBusy}
          onPick={async (track) => {
            touched();
            if (await pickInstagramSound(track)) setSheet(null);
          }}
          onMore={() => setSheet("music")}
          onClose={closeSheet}
        />
      ) : null}

      {sheet === "autopilot" ? (
        <AutopilotSheet
          phase={autopilotPhase}
          uploading={uploads.length}
          shots={timeline.clips.map((clip) => ({ id: clip.id, thumbUrl: library[clip.assetId]?.thumbUrl ?? null, room: clip.room }))}
          pending={uploads.map((upload) => ({ key: upload.key, thumbUrl: upload.thumbUrl, progress: upload.progress }))}
          naming={naming > 0}
          onRoom={(clipId, room) => apply((current) => setClipRoom(current, clipId, room))}
          error={autopilotError?.message ?? null}
          upgrade={autopilotError?.upgrade ?? false}
          onGo={(style, info) => {
            autopilotRequest.current = { style, info };
            setAutopilotError(null);
            setAutopilotPhase("waiting");
          }}
          onClose={() => {
            if (autopilotPhase === "form") setSheet(null);
          }}
        />
      ) : null}

      {sheet === "export" ? (
        <ExportSheet
          issues={issues}
          durationMs={totalMs}
          busy={exportState.busy}
          error={exportState.error}
          upgrade={exportState.upgrade}
          instagramSound={musicInstagram ? instagramAudioLabel(musicInstagram) : null}
          onExport={confirmExport}
          onShowIssue={(issue) => {
            if (issue.textId) selectAndShow({ kind: "text", id: issue.textId });
            setGuides(true);
            setSheet(null);
          }}
          onClose={closeSheet}
        />
      ) : null}
    </div>
  );
}
