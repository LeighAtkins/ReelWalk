"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { PlayerRef } from "@remotion/player";
import {
  addClips,
  addRoomLabels,
  canWalk,
  hasRoomLabels,
  removeRoomLabels,
  setDetails,
  setPlan,
  snapCutsToBeats,
  addText,
  clipStartsMs,
  DEFAULT_IMAGE_MS,
  DEFAULT_PANO,
  DEFAULT_PANO_MS,
  duplicateClip,
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
  type Issue,
  type Plan,
  type Timeline,
} from "@reelwalk/core";
import type { ReelAsset } from "@reelwalk/render/reel";
import { deleteReel, exportReel } from "@/app/actions";
import { formatDuration } from "@/lib/format";
import type { LibraryAsset } from "@/lib/library";
import { takePendingFiles } from "@/lib/pending-files";
import {
  CaptionIcon,
  CheckIcon,
  ClockIcon,
  CloseIcon,
  DetailsIcon,
  DuplicateIcon,
  EditIcon,
  FilterIcon,
  FitIcon,
  GuidesIcon,
  MotionIcon,
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
import { Filmstrip, type PendingUpload, type Selection } from "./filmstrip";
import { historyReducer, initHistory } from "./history";
import {
  CaptionSheet,
  DetailsSheet,
  ExportSheet,
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
  type TextDraft,
} from "./sheets";
import { uploadFile } from "./upload";
import { useAutosave } from "./use-autosave";

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
  | "music"
  | "caption"
  | "export";

export type EditorProps = {
  /** Open the media library straight away (a reel started from the library). */
  openLibrary?: boolean;
  /** Floor plans of the home tours the library media belongs to. */
  tours?: Record<string, { name: string; plan: Plan }>;
  reel: { id: string; title: string; revision: number; caption: string };
  timeline: Timeline;
  library: LibraryAsset[];
};

const newId = () => crypto.randomUUID();
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

export function Editor({ reel, timeline: initialTimeline, library: initialLibrary, openLibrary, tours = {} }: EditorProps) {
  const router = useRouter();
  const [history, dispatch] = useReducer(historyReducer, initialTimeline, initHistory);
  const timeline = history.present;
  const [title, setTitle] = useState(reel.title);
  const [caption, setCaption] = useState(reel.caption);
  const [selection, setSelection] = useState<Selection>(null);
  const [sheet, setSheet] = useState<SheetName | null>(openLibrary && initialTimeline.clips.length === 0 ? "media" : null);
  const [library, setLibrary] = useState<Record<string, LibraryAsset>>(() => Object.fromEntries(initialLibrary.map((asset) => [asset.id, asset])));
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [musicUploading, setMusicUploading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [guides, setGuides] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [exportState, setExportState] = useState<{ busy: boolean; error: string | null; issues: Issue[] | null }>({ busy: false, error: null, issues: null });
  const clock = useMemo(() => createClock(), []);
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
  const tipOnce = useCallback(
    (key: string, message: string) => {
      try {
        if (localStorage.getItem(`reelwalk.tip.${key}`)) return;
        localStorage.setItem(`reelwalk.tip.${key}`, "1");
      } catch {
        return;
      }
      showToast(message, 5500);
    },
    [showToast],
  );

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
      setSheet(null);
      const batch = files.map((file) => ({
        key: newId(),
        file,
        name: file.name,
        progress: 0,
        thumbUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      }));
      setUploads((current) => [...current, ...batch.map(({ key, name, progress, thumbUrl }) => ({ key, name, progress, thumbUrl }))]);

      // Two uploads at a time, but clips are added in the order they were picked.
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
        const y = Math.min(0.62, 0.42 + textsAt(timeline, clock.get()).length * 0.1);
        const startMs = clock.get();
        apply((current) => addText(current, { ...draft, id, startMs, x: 0.5, y }));
        setSelection({ kind: "text", id });
        // Park just past the pop-in animation, so the paused preview shows the text fully.
        seek(startMs + 300);
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
    if (result && !result.ok) setExportState({ busy: false, error: result.message ?? null, issues: result.issues });
  }, [autosave, reel.id]);

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
    () => Object.fromEntries(Object.values(library).map((asset) => [asset.id, { src: asset.url, kind: asset.kind }])),
    [library],
  );
  const issues = useMemo(() => exportState.issues ?? instagramIssues(timeline, caption), [exportState.issues, timeline, caption]);
  const libraryList = useMemo(() => Object.values(library), [library]);

  const saveLabel = {
    saved: "Saved",
    unsaved: "Editing…",
    saving: "Saving…",
    error: "Not saved",
    conflict: "Not saved",
  }[autosave.status];

  // ── Toolbars ────────────────────────────────────────────────
  let tools: React.ReactNode;
  if (selectedClip) {
    const index = selectedClipIndex;
    const isVideo = selectedClip.kind === "VIDEO";
    tools = (
      <>
        <span className="toolbar-context">
          <Tool label="Done" onClick={() => setSelection(null)}>
            <CheckIcon />
          </Tool>
        </span>
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
        <Tool label="Delete" danger onClick={deleteSelection}>
          <TrashIcon />
        </Tool>
      </>
    );
  } else if (selectedText) {
    tools = (
      <>
        <span className="toolbar-context">
          <Tool label="Done" onClick={() => setSelection(null)}>
            <CheckIcon />
          </Tool>
        </span>
        <Tool label="Edit" onClick={() => setSheet("text-edit")}>
          <EditIcon />
        </Tool>
        <Tool label="Timing" onClick={() => setSheet("timing")}>
          <ClockIcon />
        </Tool>
        <Tool label="Guides" pressed={guides} onClick={() => setGuides(!guides)}>
          <GuidesIcon />
        </Tool>
        <Tool label="Delete" danger onClick={deleteSelection}>
          <TrashIcon />
        </Tool>
      </>
    );
  } else if (musicSelected) {
    tools = (
      <>
        <span className="toolbar-context">
          <Tool label="Done" onClick={() => setSelection(null)}>
            <CheckIcon />
          </Tool>
        </span>
        <Tool label="Adjust" onClick={() => setSheet("music")}>
          <VolumeIcon />
        </Tool>
        <Tool label="Replace" onClick={() => setSheet("music")}>
          <SwapIcon />
        </Tool>
        <Tool label="Remove" danger onClick={deleteSelection}>
          <TrashIcon />
        </Tool>
      </>
    );
  } else {
    tools = (
      <>
        <Tool label="Add media" onClick={() => setSheet("media")}>
          <PlusIcon />
        </Tool>
        <Tool label="Text" disabled={!hasClips} onClick={() => setSheet("text-new")}>
          <TextIcon />
        </Tool>
        <Tool label="Music" disabled={!hasClips} onClick={() => setSheet("music")}>
          <MusicIcon />
        </Tool>
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

  return (
    <div className="editor" data-testid="editor">
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
        playerRef={attachPlayer}
        playing={playing}
        guides={guides}
        selectedText={selectedText}
        onTogglePlay={togglePlay}
        clock={clock}
        onMoveText={(id, x, y, gesture) => apply((current) => updateText(current, id, { x, y }), gesture)}
        onResizeText={(id, size, gesture) => apply((current) => updateText(current, id, { size }), gesture)}
        onSelectText={(id) => setSelection({ kind: "text", id })}
        onEditText={(id) => {
          setSelection({ kind: "text", id });
          setSheet("text-edit");
        }}
        empty={
          uploads.length > 0 ? (
            <p>Uploading {uploads.length === 1 ? "1 file" : `${uploads.length} files`}…</p>
          ) : (
            <>
              <p>
                <strong>Start with your listing&apos;s photos and videos.</strong>
              </p>
              <p className="muted small">They play in the order you pick them. Vertical video fills the frame best.</p>
              <button type="button" className="btn btn-signal" onClick={() => setSheet("media")}>
                <PlusIcon size={18} />
                Add media
              </button>
            </>
          )
        }
      />

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
        <span />
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
        {tools}
      </nav>

      {toast ? (
        <p className="toast" role="status">
          {toast}
        </p>
      ) : null}

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
          onClose={closeSheet}
        />
      ) : null}

      {sheet === "text-new" ? <TextSheet initial={null} onSave={saveText} onClose={closeSheet} /> : null}
      {sheet === "text-edit" && selectedText ? <TextSheet initial={selectedText} onSave={saveText} onClose={closeSheet} /> : null}
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
          onChange={(details) => apply((current) => setDetails(current, details), "details")}
          onCaption={(text) => {
            setCaption(text);
            showToast("Caption written from the details.");
          }}
          onClose={closeSheet}
        />
      ) : null}

      {sheet === "caption" ? <CaptionSheet reelId={reel.id} caption={caption} onClose={closeSheet} onChange={setCaption} /> : null}

      {sheet === "export" ? (
        <ExportSheet
          issues={issues}
          durationMs={totalMs}
          busy={exportState.busy}
          error={exportState.error}
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
