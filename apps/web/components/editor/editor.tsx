"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { PlayerRef } from "@remotion/player";
import { canExport, fixAllCommand, safeFixes, type CriticFinding, type CriticFix,
  setHook, wordsBehindHook, locate, orientQuad, reshapePin, placementVersion, storedFraction,
  addClips,
  insertAiShot,
  luxuryFinish,
  addRoomLabels,
  canWalk,
  hasRoomLabels,
  removeRoomLabels,
  setDetails,
  setPlan,
  addText,
  clipDurationMs,
  clipStartsMs,
  DEFAULT_IMAGE_MS,
  DEFAULT_PANO,
  DEFAULT_PANO_MS,
  instagramAudioLabel,
  instagramIssues,
  MAX_TEXTS,
  REEL_FORMAT,
  removeText,
  setMusic,
  textsAt,
  timelineDurationMs,
  reelMoodInput,
  reelMoods,
  updateClip,
  updateText,
  type Clip,
  type InstagramAudioTrack,
  type Issue,
  type MusicChoice,
  hasSpeech,
  pastSongEndMs,
  type Plan,
  type SongMap,
  type Timeline,
  setClipRoom,
  setCover,
  setLogo,
  setLook,
  keepTextsClearOfCard,
  currentFinish,
  FINISHES,
  type FinishId,
  hookTextRequest,
} from "@reelwalk/core";
import { ELEGANT_FADE_S, type ReelAsset } from "@reelwalk/render/reel";
import { deleteReel, exportReel, readyPreviews, saveCaption } from "@/app/actions";
import { deleteBrief, saveBrief } from "@/app/ai-actions";
import { analyseInstagramSound } from "@/app/instagram-audio-actions";
import { runAiJob } from "@/lib/ai-jobs-client";
import { LookChoices, MusicChoices, TextChoices, TimingChoices } from "./review";
import { chooseSound } from "@/lib/instagram-sounds-client";
import { formatDuration } from "@/lib/format";
import type { LibraryAsset } from "@/lib/library";
import { hasPendingFiles, takePendingFiles } from "@/lib/pending-files";
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
  PopIcon,
  PremiumIcon,
  ReelSettingsIcon,
} from "../icons";
import { AskBox } from "./ask-box";
import { BUILT_IN_CONTROLS, controlsFor, isPresenterClip, targetsFor, type ControlContext, type ResolvedControl } from "./controls";
import { EXTENSION_CONTROLS } from "./control-extensions";
import { replaceClipSource } from "./replace-clip";
import { createClock, useClock, type Clock } from "./clock";
import { ClipSourceInfo } from "./clip-source-info";
import { DirectorSheet } from "./director-sheet";
import { ScriptSheet, useScriptRun } from "./script-sheet";
import { Filmstrip, type PendingUpload, type Selection } from "./filmstrip";
import { STALE_PROPOSAL, useDocument } from "./use-document";
import { useCritic } from "./use-critic";
import { CriticPanel } from "./critic-panel";
import { polishDraft, runAutopilot, type AutopilotDraft } from "./autopilot-flow";
import { landProposal, reviewGeneration } from "./proposals";
import { HookStudio } from "./hook-studio";
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
  pinTitle,
} from "./sheets";
import { analyseStoredAudio, uploadFile } from "./upload";
import { BeatControl } from "./beat-control";
import { measureClipEnergies } from "./clip-energy";
import { useAutosave } from "./use-autosave";
import { AiVideoPanel } from "../ai-video-panel";
import { Sheet } from "./sheets";
import type { InspectSource } from "./inspect";

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
  | "presenter"
  | "autopilot"
  | "review-text"
  | "review-timing"
  | "review-music"
  | "review-look"
  // ADR 0064: the Reel sheet, replacing a clip, a title's particles or walk-through, and extension panels.
  | "reel"
  | "replace"
  | "text-particles"
  | "text-walk"
  | `ext:${string}`;

/** Every control the toolbar can show: the editor's own and the ones other features mount (ADR 0064). */
const CONTROL_SPECS = [...BUILT_IN_CONTROLS, ...EXTENSION_CONTROLS];
type ControlHandler = { icon: React.ReactNode; onClick(): void; pressed?: boolean; disabled?: boolean; danger?: boolean };

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
  /** Whether the Music sheet offers Instagram's sounds (null: not on this deployment). */
  instagramSounds?: InstagramSoundAccess;
  /** This month's AI requests and allowance (null: no AI here), for the "Polish with AI" chip (ADR 0064). */
  aiUsage?: { used: number; allowed: number } | null;
};

const newId = () => crypto.randomUUID();

/** What the autopilot endpoint answers (ADR 0021, 0024). */
type AutopilotCutResult = { ok: true; timeline: unknown; note: string; assets?: LibraryAsset[]; instagramPick?: InstagramAudioTrack } | { ok: false; message: string };

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
  ariaLabel,
}: {
  label: string;
  /** The accessible name when the visible label is a short form. */
  ariaLabel?: string;
  onClick(): void;
  children: React.ReactNode;
  disabled?: boolean;
  pressed?: boolean;
  danger?: boolean;
}) {
  return (
    <button type="button" className={`tool${danger ? " tool-danger" : ""}`} onClick={onClick} disabled={disabled} aria-pressed={pressed} aria-label={ariaLabel}>
      {children}
      {label}
    </button>
  );
}

/** Assets whose clips carry speech: pacing never cuts into those clips when their sound is on (ADR 0059). */
function speechAssetIds(library: Record<string, LibraryAsset>): string[] {
  return Object.values(library).filter((asset) => asset.kind === "VIDEO" && hasSpeech(asset.transcript)).map((asset) => asset.id);
}

/** A song's tempo and, when it was analysed, its bars and sections (ADR 0059), as the reel's music carries them. */
function songFields(asset: LibraryAsset): Pick<MusicChoice, "bpm" | "beatOffsetMs" | "downbeats" | "sections"> {
  return { bpm: asset.bpm, beatOffsetMs: asset.beatOffsetMs, ...(asset.songMap ? { downbeats: asset.songMap.downbeats, sections: asset.songMap.sections } : {}) };
}

export function Editor({ reel, timeline: initialTimeline, library: initialLibrary, openLibrary, tours = {}, instagramSounds = null, askAvailable = false, briefs: initialBriefs = [], autopilot = false, aiUsage: initialAiUsage = null }: EditorProps) {
  const [aiUsage, setAiUsage] = useState(initialAiUsage);
  const [briefs, setBriefs] = useState<Brief[]>(initialBriefs);
  // One entry (ADR 0064): a reel started from the home screen goes straight from the upload to a
  // finished first cut, with no form. Only when the picked files are waiting in this tab: a reload,
  // a second tab or an old link with ?auto=1 opens the reel as it is.
  const [autoStart] = useState(() => autopilot && isFresh(initialTimeline) && hasPendingFiles(reel.id));
  const [autopilotPhase, setAutopilotPhase] = useState<AutopilotPhase>(autoStart ? "waiting" : "form");
  const [autopilotError, setAutopilotError] = useState<{ message: string; upgrade: boolean } | null>(null);
  const autopilotRequest = useRef<{ style: string; info: AutopilotInfo } | null>(autoStart ? { style: "just-listed", info: { address: "", price: "", beds: "", baths: "", area: "", openHouse: "" } } : null);
  // Set once the files picked on the home screen have started uploading (or there were none), so the cut does not start before them.
  const [uploadsArmed, setUploadsArmed] = useState(false);
  // Rooms are named while the shots upload; the cut waits a few seconds for the names, never longer.
  const [namingWaited, setNamingWaited] = useState(false);
  // "Make it pop" / "Make it premium" while its song is being fetched.
  const [finishing, setFinishing] = useState<FinishId | null>(null);
  // Words sent from the Ask box, which the Ask sheet runs as it opens.
  const [askSeed, setAskSeed] = useState<{ request: string; auto: boolean } | null>(null);
  // "Write me 5 hooks" in the Ask box opens the Hook studio asking for that many lines (ADR 0068).
  const [hookLines, setHookLines] = useState<number | null>(null);
  const router = useRouter();
  const [library, setLibrary] = useState<Record<string, LibraryAsset>>(() => Object.fromEntries(initialLibrary.map((asset) => [asset.id, asset])));
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const sourceDurations = useCallback(() => Object.fromEntries(Object.values(libraryRef.current).map((entry) => [entry.id, entry.durationMs])), []);
  // The reel, its undo history and its generation (ADR 0048). Changes to the cut go through runCommand.
  const { history, generation, dispatch, runCommand: runDocumentCommand, snapshot, endGesture } = useDocument(initialTimeline, sourceDurations);
  const timeline = history.present;
  const [title, setTitle] = useState(reel.title);
  const [caption, setCaption] = useState(reel.caption);
  const [selection, setSelection] = useState<Selection>(null);
  const [sheet, setSheet] = useState<SheetName | null>(autoStart ? "autopilot" : openLibrary && initialTimeline.clips.length === 0 ? "media" : null);
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [musicUploading, setMusicUploading] = useState(false);
  // Editing to the beat (ADR 0059): measured clip motion and song bars, gathered when the Music sheet opens.
  const clipEnergies = useRef<Record<string, number>>({});
  const songMaps = useRef<Record<string, SongMap>>({});
  const beatWork = useRef(false);
  const [beatMeasuring, setBeatMeasuring] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [guides, setGuides] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [exportState, setExportState] = useState<{ busy: boolean; error: string | null; issues: Issue[] | null; upgrade?: boolean }>({ busy: false, error: null, issues: null });
  const clock = useMemo(() => createClock(), []);
  const [theater, setTheater] = useState(false);
  // Check mode (ADR 0044): full screen with five moments per shot to jump between, every surface outlined.
  const [checking, setChecking] = useState(false);
  // Corner placing (ADR 0044): the frame full screen with only the selected title's corners, a loupe under the finger.
  const [placing, setPlacing] = useState<false | "corners" | "cutouts">(false);
  const [placingStatus, setPlacingStatus] = useState<{ text: string | null; busy: boolean }>({ text: null, busy: false });
  // Inspect (ADR 0057): the frame full screen, magnified up to 8×, Final or Footage only.
  const [inspecting, setInspecting] = useState(false);
  const exitTheater = useCallback(() => { setTheater(false); setChecking(false); setPlacing(false); setInspecting(false); setPlacingStatus({ text: null, busy: false }); }, []);
  const openInspect = useCallback(() => { playerRef.current?.pause(); setSheet(null); setChecking(false); setPlacing(false); setInspecting(true); setTheater(true); }, []);
  const openCorners = useCallback((tool: "corners" | "cutouts" = "corners") => { playerRef.current?.pause(); setChecking(false); setPlacing(tool); setTheater(true); }, []);
  const playerRef = useRef<PlayerRef>(null);
  // The Player loads after this component and remounts when the reel goes
  // from empty to non-empty; state makes the event subscription follow it.
  const [player, setPlayer] = useState<PlayerRef | null>(null);
  const attachPlayer = useCallback((instance: PlayerRef | null) => {
    playerRef.current = instance;
    setPlayer(instance);
  }, []);
  const autosave = useAutosave(reel.id, reel.revision, timeline, title);
  // Script mode (ADR 0060): an approved script's takes are followed while the editor is open, not only the sheet.
  const scriptRun = useScriptRun(reel.id);
  const scriptReady = scriptRun.toPlace.length;

  const totalMs = timelineDurationMs(timeline);
  const apply = useCallback((update: (timeline: Timeline) => Timeline, key?: string) => dispatch({ type: "apply", update, key }), []);

  const showToast = useCallback((message: string, ms = 2600) => {
    setToast(message);
    setTimeout(() => setToast((current) => (current === message ? null : current)), ms);
  }, []);

  const rejectedKey = useRef<string | null>(null);
  /** Every command goes through here: one that could not be applied says so instead of doing nothing (ADR 0048). */
  const runCommand = useCallback(
    (...args: Parameters<typeof runDocumentCommand>) => {
      const result = runDocumentCommand(...args);
      const key = args[1] ?? null;
      if (result.warning) console.warn("command applied to a reel that was already invalid", args[0].type, result.warning);
      if (result.rejected) {
        console.warn("command rejected", args[0].type, result.rejected);
        // Once per gesture, not on every pointer move of a drag.
        if (key === null || rejectedKey.current !== key) showToast("That change could not be made, so the reel is as it was.", 4000);
        rejectedKey.current = key;
      } else rejectedKey.current = null;
      return result;
    },
    [runDocumentCommand, showToast],
  );

  // A script's takes finishing while the studio edits: say so once, and the Presenter button shows it.
  useEffect(() => {
    if (scriptReady > 0) showToast(`${scriptReady === 1 ? "A presenter take is" : `${scriptReady} presenter takes are`} ready. Tap Presenter on the timeline to place ${scriptReady === 1 ? "it" : "them"}.`, 5000);
  }, [scriptReady, showToast]);

  // A sheet opening or closing ends any slider gesture: the next change is its own step with its own baseline.
  const sheetOpenedAt = useRef(0);
  useEffect(() => {
    sheetOpenedAt.current = Date.now();
    endGesture();
  }, [sheet, endGesture]);

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

  // Words from the Ask box are for the Ask sheet they opened, never a later one.
  useEffect(() => {
    if (sheet !== "ask") setAskSeed(null);
  }, [sheet]);
  useEffect(() => {
    if (sheet !== "hook") setHookLines(null);
  }, [sheet]);

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

  // ?auto=1 has done its work once the editor is open: reopening the address opens the reel.
  useEffect(() => {
    if (window.location.search.includes("auto=1")) window.history.replaceState(window.history.state, "", window.location.pathname);
  }, []);

  // Files picked on the home screen arrive with the navigation.
  const pendingTaken = useRef(false);
  useEffect(() => {
    if (pendingTaken.current) return;
    pendingTaken.current = true;
    const files = takePendingFiles(reel.id);
    if (files.length > 0) void addFiles(files);
    // Batched with addFiles' first state update: the next render already counts the uploads.
    setUploadsArmed(true);
  }, [reel.id, addFiles]);

  const uploadMusic = useCallback(
    async (file: File) => {
      setMusicUploading(true);
      try {
        const asset = await uploadFile(file, () => undefined);
        if (asset.kind !== "AUDIO") throw new Error(`${file.name} is not an audio file.`);
        setLibrary((current) => ({ ...current, [asset.id]: asset }));
        runCommand({ type: "setMusic", music: { assetId: asset.id, sourceStartMs: 0, volume: 0.8, ...songFields(asset) } });
        setSelection({ kind: "music" });
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Could not upload the song.");
      } finally {
        setMusicUploading(false);
      }
    },
    [runCommand, showToast],
  );

  // Editing to an Instagram sound (ADR 0019): the server keeps a private copy
  // of its preview; its length and tempo are found here, like an upload's.
  const [instagramBusy, setInstagramBusy] = useState<string | null>(null);
  /** Gets an Instagram sound ready to set (its private copy, length and tempo) without changing the reel. Null when it could not. */
  const fetchInstagramSound = useCallback(
    async (track: InstagramAudioTrack): Promise<MusicChoice | null> => {
      setInstagramBusy(track.id);
      try {
        const result = await chooseSound({ audioId: track.id, type: track.type, title: track.title, artist: track.artist });
        if (!result.ok) {
          showToast(result.error, 5000);
          return null;
        }
        let asset = result.asset;
        // Measured once per copy; a sound chosen again already knows its tempo.
        if (asset.durationMs === null) {
          const analysis = await analyseStoredAudio(asset.url);
          if (analysis.durationMs !== null) {
            asset = { ...asset, durationMs: analysis.durationMs, bpm: analysis.beat?.bpm ?? null, beatOffsetMs: analysis.beat?.offsetMs ?? null, songMap: analysis.songMap };
            void analyseInstagramSound({
              assetId: asset.id,
              durationMs: analysis.durationMs,
              bpm: asset.bpm,
              beatOffsetMs: asset.beatOffsetMs,
              songMap: analysis.songMap,
              catalogueMs: track.durationMs,
            }).catch(() => undefined);
          }
        }
        const chosen = asset;
        setLibrary((current) => ({ ...current, [chosen.id]: chosen }));
        libraryRef.current = { ...libraryRef.current, [chosen.id]: chosen };
        return { assetId: chosen.id, sourceStartMs: 0, ...songFields(chosen), instagramAudioId: chosen.instagram?.audioId ?? track.id };
      } catch {
        showToast("Could not get that sound from Instagram. Try again.");
        return null;
      } finally {
        setInstagramBusy(null);
      }
    },
    [showToast],
  );

  // With the Music sheet open on a song analysed before ADR 0059: find its bars and sections from the same copy the
  // editor plays (never baked into an export), so the first Energy change can cut to them.
  const musicSheetOpen = sheet === "music";
  useEffect(() => {
    const music = snapshot().timeline.music;
    if (!musicSheetOpen || !music?.bpm || music.downbeats?.length) return;
    const asset = libraryRef.current[music.assetId];
    if (!asset || songMaps.current[asset.id]) return;
    if (asset.songMap) {
      songMaps.current[asset.id] = asset.songMap;
      return;
    }
    void analyseStoredAudio(asset.url).then((analysis) => {
      if (analysis.songMap) songMaps.current[asset.id] = analysis.songMap;
    });
  }, [musicSheetOpen, timeline.music?.assetId, timeline.music?.bpm, snapshot]);

  /**
   * How much each clip moves, measured on the first Energy change only (five small frames per video: too much work for
   * a phone just for opening the sheet). That first change is cut without a hero; the hero comes with the next one.
   */
  const measureForPace = useCallback(() => {
    const current = snapshot().timeline;
    if (beatWork.current || current.clips.every((clip) => clip.kind !== "VIDEO" || clipEnergies.current[clip.id] !== undefined)) return;
    beatWork.current = true;
    setBeatMeasuring(true);
    void measureClipEnergies(current, libraryRef.current, clipEnergies.current)
      .then((measured) => Object.assign(clipEnergies.current, measured))
      .finally(() => {
        beatWork.current = false;
        setBeatMeasuring(false);
      });
  }, [snapshot]);
  const pastSongWarned = useRef(false);

  const pickInstagramSound = useCallback(
    async (track: InstagramAudioTrack): Promise<boolean> => {
      const music = await fetchInstagramSound(track);
      if (!music) return false;
      // The song and the cuts moving onto its beat (room labels with them) are one step: one undo takes both back.
      runCommand({ type: "setMusic", music, snap: true });
      setSelection({ kind: "music" });
      showToast(`“${track.title}” added${music.bpm ? ", cuts on the beat" : ""}.`);
      return true;
    },
    [fetchInstagramSound, runCommand, showToast],
  );

  /** How Ask, Make it for me and the director apply what they bring back (proposals.ts). */
  // The document's own runCommand: each path reports a refused proposal in its own words.
  const proposalDeps = useMemo(() => ({ runCommand: runDocumentCommand, snapshot, fetchSound: fetchInstagramSound }), [runDocumentCommand, snapshot, fetchInstagramSound]);

  // ── Two finishes (ADR 0064) ─────────────────────────────────
  // "Make it pop" / "Make it premium": the server picks a song for the mood from the same list Ask uses
  // (or says keep this one); the song is fetched, then music, type, pace and look land as one command.
  const finishReel = useCallback(
    async (id: FinishId) => {
      const finish = FINISHES[id];
      setFinishing(id);
      try {
        const music = snapshot().timeline.music;
        let choice: MusicChoice | null = null;
        let songNote = music && !music.autoPicked ? "kept your song" : "kept the song";
        try {
          const response = await fetch(`/api/reels/${reel.id}/finish`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ finish: id, assetId: music?.assetId ?? null, instagramAudioId: music?.instagramAudioId ?? null, autoPicked: music?.autoPicked ?? false }),
          });
          const data = (await response.json()) as { ok: boolean; song?: { title: string; asset?: LibraryAsset; instagram?: InstagramAudioTrack } | null };
          if (data.ok && data.song?.instagram) {
            choice = await fetchInstagramSound(data.song.instagram);
            if (choice) songNote = `“${data.song.title}”`;
          } else if (data.ok && data.song?.asset) {
            const asset = data.song.asset;
            setLibrary((current) => ({ ...current, [asset.id]: asset }));
            libraryRef.current = { ...libraryRef.current, [asset.id]: asset };
            choice = { assetId: asset.id, sourceStartMs: 0, ...songFields(asset) };
            songNote = `“${data.song.title}”`;
          }
        } catch {
          // Offline or no song list: the finish still sets the type, pace and look.
        }
        // Paced like the Energy control (ADR 0059): measured clip motion so far, the song's bars when known, speech held.
        const songId = choice?.assetId ?? music?.assetId;
        const result = runCommand({ type: "applyFinish", finish: id, music: choice, speechAssetIds: speechAssetIds(libraryRef.current), clipEnergy: { ...clipEnergies.current }, songMap: songId ? (songMaps.current[songId] ?? libraryRef.current[songId]?.songMap ?? undefined) : undefined });
        if (!result.rejected) showToast(`${finish.label.replace("Make it ", "").replace(/^./, (c) => c.toUpperCase())}: ${finish.summary}; ${songNote}. Undo takes it back.`, 6000);
      } finally {
        setFinishing(null);
      }
    },
    [reel.id, snapshot, fetchInstagramSound, runCommand, showToast],
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
    const id = newId();
    if (runCommand({ type: "splitClip", atMs: clock.get(), newId: id }).changes.length === 0) {
      showToast("Move the playhead at least half a second away from a clip's edge to split it.");
      return;
    }
    setSelection({ kind: "clip", id });
  }, [runCommand, clock, showToast]);

  const deleteSelection = useCallback(() => {
    if (!activeSelection) return;
    if (activeSelection.kind === "clip") runCommand({ type: "deleteClip", clipId: activeSelection.id });
    if (activeSelection.kind === "text") apply((current) => removeText(current, activeSelection.id));
    if (activeSelection.kind === "music") runCommand({ type: "setMusic", music: null });
    setSelection(null);
    setSheet(null);
  }, [activeSelection, apply, runCommand]);

  const saveText = useCallback(
    (draft: TextDraft) => {
      if (sheet === "text-edit" && selectedText) {
        apply((current) => updateText(current, selectedText.id, draft));
      } else {
        // The direct edit path may not take a reel past the most texts it can have (it would then refuse every command).
        if (timeline.texts.length >= MAX_TEXTS) {
          showToast(`A reel can have up to ${MAX_TEXTS} texts. Delete one to add another.`, 4000);
          setSheet(null);
          return;
        }
        const id = newId();
        // Stacked texts start lower, so a second one does not cover the first.
        // Elegant text sits in the middle of the picture, the way the luxury reels place it.
        const elegant = draft.style === "elegant";
        const y = Math.min(elegant ? 0.7 : 0.62, (elegant ? 0.5 : 0.42) +textsAt(timeline, clock.get()).length * 0.1);
        const startMs = clock.get();
        // A callout's label sits right of centre with its point below-left of it (ADR 0061); the dot is then dragged onto the feature.
        apply((current) => addText(current, draft.callout ? { ...draft, id, startMs, x: 0.62, y: 0.5, callout: { x: 0.4, y: 0.64 } } : { ...draft, id, startMs, x: 0.5, y }));
        setSelection({ kind: "text", id });
        if (draft.callout) showToast("Drag the blue dot onto the feature, then Pin it to follow it.", 4000);
        // Park just past the entry animation (pop or slow fade), so the paused preview shows the text fully.
        seek(startMs + (elegant ? ELEGANT_FADE_S * 1000 + 100 : 300));
      }
      setSheet(null);
    },
    [apply, clock, seek, selectedText, sheet, showToast, timeline],
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

  // Corners are set on the first frame of the shot (ADR 0044): opening Pin goes there.
  const selectedTextId = selectedText?.id;
  useEffect(() => {
    if (sheet !== "pin" || !selectedTextId) return;
    const text = timeline.texts.find((item) => item.id === selectedTextId);
    const at = text ? locate(timeline, text.startMs) : null;
    if (!text || !at) return;
    playerRef.current?.pause();
    seek(text.startMs - at.offsetMs + 1000 / REEL_FORMAT.fps);
    // Only when the sheet opens, not on every edit made in it.
  }, [sheet, selectedTextId]);

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

  // ── Check before export (ADR 0044) ─────────────────────────
  const checkMarks = useMemo(() => {
    const starts = clipStartsMs(timeline);
    const frameMs = 1000 / REEL_FORMAT.fps;
    return timeline.clips.flatMap((clip, index) => {
      const length = clipDurationMs(clip);
      return [0, 0.25, 0.5, 0.75, 1].map((share, k) => ({
        label: `${index + 1}${["a", "b", "c", "d", "e"][k]}`,
        ms: Math.round(starts[index] + Math.min(Math.max(share * length, frameMs), Math.max(frameMs, length - frameMs))),
      }));
    });
  }, [timeline]);
  const openCheck = useCallback(() => {
    playerRef.current?.pause();
    setSheet(null);
    setChecking(true);
    setTheater(true);
    if (checkMarks.length) seek(checkMarks[0].ms);
  }, [checkMarks, seek]);

  // The placing screen's marks: the five moments of the selected title's shot; and Track, run right there.
  const placingShot = useMemo(() => {
    if (!selectedText) return null;
    const at = locate(timeline, selectedText.startMs);
    if (!at) return null;
    const clip = timeline.clips[at.index];
    const start = clipStartsMs(timeline)[at.index];
    const length = clipDurationMs(clip);
    const frameMs = 1000 / REEL_FORMAT.fps;
    const marks = [0, 0.25, 0.5, 0.75, 1].map((share, k) => ({ label: ["start", "¼", "½", "¾", "end"][k], ms: Math.round(start + Math.min(Math.max(share * length, frameMs), Math.max(frameMs, length - frameMs))) }));
    return { clip, clipStartMs: selectedText.startMs - at.offsetMs, marks };
  }, [selectedText, timeline]);
  // A track is versioned and cancellable (ADR 0047): it captures the title's placement version when it
  // starts, and its result is applied only if the placement is unchanged when it arrives. Leaving the
  // placing screen cancels it.
  const timelineNow = useRef(timeline);
  timelineNow.current = timeline;
  const placingTrack = useRef<AbortController | null>(null);
  useEffect(() => { if (!placing) { placingTrack.current?.abort(); placingTrack.current = null; } }, [placing]);
  const trackInPlace = useCallback(async () => {
    if (!selectedText || !placingShot) return;
    const asset = library[placingShot.clip.assetId];
    if (!asset || placingShot.clip.kind !== "VIDEO") { setPlacingStatus({ text: "Tracking needs the title to start on a video clip.", busy: false }); return; }
    placingTrack.current?.abort();
    const controller = new AbortController();
    placingTrack.current = controller;
    const id = selectedText.id;
    const version = placementVersion(timelineNow.current, id);
    setPlacingStatus({ text: "Following the surface through the shot…", busy: true });
    const result = await pinTitle({ text: selectedText, clip: placingShot.clip, asset, clipStartMs: placingShot.clipStartMs, wholeShot: true, lean: { yaw: selectedText.pin?.lean?.yaw ?? 0, pitch: selectedText.pin?.lean?.pitch ?? 0 }, signal: controller.signal, onProgress: (fraction) => setPlacingStatus({ text: `Following the surface through the shot… ${Math.round(fraction * 100)}%`, busy: true }) });
    if (controller.signal.aborted) return;
    placingTrack.current = null;
    if ("error" in result) { setPlacingStatus({ text: result.error, busy: false }); return; }
    if (placementVersion(timelineNow.current, id) !== version) {
      setPlacingStatus({ text: "The corners or the shot changed while tracking, so that track was discarded. Press Track again.", busy: false });
      return;
    }
    // Checked again against the timeline the edit actually lands on.
    apply((current) => placementVersion(current, id) === version ? updateText(current, id, { path: result.pinned.path, pin: result.pinned.pin, ...result.patch }) : current, `pin-${id}`);
    setPlacingStatus({ text: `${result.status} Step through the shot below.`, busy: false });
  }, [selectedText, placingShot, library, apply]);

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
  // and replaces it, as one undoable step, unless the reel has changed in the
  // meantime: the polish is a proposal against the first cut's generation,
  // made from the same input as that cut (autopilot-flow.ts, ADR 0048).
  const [polishing, setPolishing] = useState(false);
  // The first cut the model may polish, while the reel is still exactly that cut (ADR 0064).
  const [polishable, setPolishable] = useState<{ draft: AutopilotDraft; style: string; info: AutopilotInfo } | null>(null);
  const autopilotSteps = useCallback(
    (style: string, info: AutopilotInfo) => ({
      snapshot,
      quick: async (from: Timeline) => {
        const response = await fetch(`/api/reels/${reel.id}/autopilot`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timeline: from, style, info, quick: true }) });
        return (await response.json()) as AutopilotCutResult;
      },
      polish: (from: Timeline) => runAiJob<AutopilotCutResult>(`/api/reels/${reel.id}/autopilot`, { timeline: from, style, info }),
      // The cut, and the Instagram sound it chose snapped to, land as one proposal against `baseGeneration`.
      takeIn: (data: AutopilotCutResult & { ok: true }, baseGeneration: number) => {
        if (data.assets?.length) setLibrary((current) => ({ ...current, ...Object.fromEntries(data.assets!.map((asset) => [asset.id, asset])) }));
        return landProposal(proposalDeps, baseGeneration, data.timeline, data.instagramPick, { autoPicked: true });
      },
    }),
    [reel.id, snapshot, proposalDeps],
  );
  const polishEvents = useMemo(
    () => ({
      polished: () => {
        setPolishing(false);
        showToast("Polished: order, cut and text by ReelWalk. Undo brings the first cut back.", 7000);
      },
      polishStale: () => {
        setPolishing(false);
        showToast("The reel changed while ReelWalk polished it, so your version stays. Review it, or ask for a change.", 6000);
      },
      polishFailed: (message: string) => {
        setPolishing(false);
        showToast(message, 6000);
      },
    }),
    [showToast],
  );
  const [naming, setNaming] = useState(0);
  // Once the shots are up, the room names get a few seconds to arrive.
  const shotsUp = autopilotPhase === "waiting" && uploadsArmed && uploads.length === 0;
  useEffect(() => {
    if (!shotsUp || namingWaited) return;
    const timer = setTimeout(() => setNamingWaited(true), 6000);
    return () => clearTimeout(timer);
  }, [shotsUp, namingWaited]);
  useEffect(() => {
    if (autopilotPhase !== "waiting" || !uploadsArmed || uploads.length > 0 || !autopilotRequest.current) return;
    // The rooms named as the shots arrived go into the first cut's labels; a slow answer is not waited for.
    if (!namingWaited && (naming > 0 || (sheet === "autopilot" && timeline.clips.some((clip) => !clip.room && !roomsAsked.current.has(clip.assetId))))) return;
    if (timeline.clips.length === 0) {
      setAutopilotPhase("form");
      setAutopilotError({ message: "None of the shots uploaded. Pick them again from the home screen.", upgrade: false });
      return;
    }
    const { style, info } = autopilotRequest.current;
    autopilotRequest.current = null;
    setAutopilotPhase("cutting");
    // Only the rule cut runs by itself: it spends no AI allowance. The model's polish is a one-tap chip on the cut (ADR 0064).
    void runAutopilot<AutopilotCutResult>(
      autopilotSteps(style, info),
      {
        fail: (message) => {
          setAutopilotPhase("form");
          setAutopilotError({ message, upgrade: false });
        },
        // A draft, not an export (ADR 0022): the editor opens on the finished cut (ADR 0064), where
        // tapping a title, a shot or the music changes it, and the two finishes restyle it whole.
        draft: (draft) => {
          setAutopilotPhase("form");
          setSheet(null);
          setSelection(null);
          setPolishable({ draft, style, info });
          showToast("Here is your first cut, with music, titles and a hook. Tap anything to change it.", 6000);
        },
        ...polishEvents,
      },
      STALE_PROPOSAL,
      "later",
    );
  }, [autopilotPhase, uploadsArmed, uploads.length, naming, namingWaited, sheet, timeline.clips, showToast, autopilotSteps, polishEvents]);

  /** The model's polish of the first cut, when the studio taps for it: one AI request from the month's allowance. */
  const polishNow = useCallback(() => {
    if (!polishable) return;
    const { draft, style, info } = polishable;
    setPolishable(null);
    setPolishing(true);
    void polishDraft(autopilotSteps(style, info), draft, polishEvents).finally(() => setAiUsage((current) => (current ? { ...current, used: current.used + 1 } : current)));
  }, [polishable, autopilotSteps, polishEvents]);

  // Rooms named as soon as the shots are up, so they show (and can be changed) before the reel is made.
  const roomsAsked = useRef(new Set<string>());
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
        // Nothing to name (the cut already has these rooms) leaves the reel, and its generation, as they are.
        apply((current) => (current.clips.some((clip) => !clip.room && rooms[clip.assetId]) ? { ...current, clips: current.clips.map((clip) => (clip.room || !rooms[clip.assetId] ? clip : { ...clip, room: rooms[clip.assetId] })) } : current));
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
      // I opens and closes Inspect; while it is open only the playhead keys reach the editor, never an edit.
      if (event.key.toLowerCase() === "i" && !mod && !event.altKey) {
        if (inspecting) exitTheater();
        else if (timeline.clips.length > 0 && !theater) openInspect();
        return;
      }
      if (inspecting && !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
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
  }, [activeSelection, clock, deleteSelection, exitTheater, inspecting, openInspect, seek, sheet, split, theater, timeline.clips.length, togglePlay, totalMs]);

  const assets = useMemo<Record<string, ReelAsset>>(
    () => Object.fromEntries(Object.values(library).map((asset) => [asset.id, { src: asset.url, kind: asset.kind, transcript: asset.transcript }])),
    [library],
  );
  // What Inspect reads beyond the Player's media: the size and an AI take's face hint (the original is asked for on demand).
  const inspectSources = useMemo<Record<string, InspectSource>>(
    () => Object.fromEntries(Object.values(library).map((asset) => [asset.id, { width: asset.width, height: asset.height, ai: Boolean(asset.isAiGenerated), face: asset.face ?? null }])),
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

  // ── The critic before export (ADR 0062) ────────────────────
  // Runs while the Export sheet is open; every fix is one command, one undo step.
  const headline = useMemo(() => {
    const name = title.split(":")[0].trim();
    return name && !/^reel \d+$/i.test(name) ? name : null;
  }, [title]);
  const critic = useCritic({ timeline, library, active: sheet === "export", headline, sourceDurationsMs: sourceDurations });
  const criticSafeCount = useMemo(() => safeFixes(critic.findings).length, [critic.findings]);
  const applyCriticFix = useCallback((_finding: CriticFinding, fix: CriticFix) => {
    if (fix.kind === "open") {
      // A new AI take costs a credit: open the AI sheet on that shot rather than starting one.
      setSelection({ kind: "clip", id: fix.clipId });
      setSheet(fix.sheet);
      return;
    }
    const result = runCommand(fix.command);
    if (!result.rejected && result.changes.length) showToast("Fixed. Undo puts it back.");
  }, [runCommand, showToast]);
  const fixAllCritic = useCallback(() => {
    const command = fixAllCommand(critic.findings);
    if (!command) return;
    const result = runCommand(command);
    if (!result.rejected && result.changes.length) showToast("Fixed. One undo puts it all back.");
  }, [critic.findings, runCommand, showToast]);
  const showFinding = useCallback((finding: CriticFinding) => {
    playerRef.current?.pause();
    setSheet(null);
    if (finding.textId) selectAndShow({ kind: "text", id: finding.textId });
    else if (finding.clipId) setSelection({ kind: "clip", id: finding.clipId });
    seek(finding.atMs);
  }, [selectAndShow, seek]);
  const libraryList = useMemo(() => Object.values(library), [library]);
  const musicInstagram = timeline.music ? (library[timeline.music.assetId]?.instagram ?? null) : null;

  const saveLabel = {
    saved: "Saved",
    unsaved: "Editing…",
    saving: "Saving…",
    error: "Not saved",
    conflict: "Not saved",
  }[autosave.status];

  // ── Toolbars: what a tap reaches (ADR 0064) ─────────────────
  // The controls come from one registry (controls.ts) for the thing selected:
  // nothing (the reel), a clip (and the presenter, for an AI take), a title or the music.
  const selectedAsset = selectedClip ? library[selectedClip.assetId] : undefined;
  const presenterSelected = selectedClip ? isPresenterClip(selectedClip.id, selectedAsset) : false;
  const controlContext: ControlContext = {
    timeline,
    clip: selectedClip,
    clipIndex: selectedClipIndex,
    text: selectedText,
    asset: selectedAsset ? { kind: selectedAsset.kind, isPano: selectedAsset.isPano, isPresenterTake: selectedAsset.isPresenterTake } : null,
    askAvailable,
    instagram: instagramSounds !== null,
  };
  const controls = controlsFor(targetsFor(activeSelection, presenterSelected), controlContext, CONTROL_SPECS);
  const finishOn = currentFinish(timeline);

  /** What each built-in control does when tapped: its icon, and whether it is on or unavailable now. */
  const handlers: Record<string, ControlHandler> = {
    // The reel
    "text-new": { icon: <TextIcon />, onClick: () => setSheet("text-new"), disabled: !hasClips },
    "music-open": { icon: <MusicIcon />, onClick: () => setSheet("music"), disabled: !hasClips },
    media: { icon: <PlusIcon />, onClick: () => setSheet("media") },
    "finish-pop": { icon: <PopIcon />, onClick: () => void finishReel("pop"), pressed: finishOn === "pop", disabled: !hasClips || finishing !== null },
    "finish-premium": { icon: <PremiumIcon />, onClick: () => void finishReel("premium"), pressed: finishOn === "premium", disabled: !hasClips || finishing !== null },
    "reel-more": { icon: <ReelSettingsIcon />, onClick: () => setSheet("reel") },
    pace: { icon: <ClockIcon />, onClick: () => setSheet("review-timing"), disabled: !hasClips },
    "look-all": { icon: <FilterIcon />, onClick: () => setSheet("review-look"), disabled: !hasClips },
    words: { icon: <EditIcon />, onClick: () => setSheet("review-text"), disabled: timeline.texts.length === 0 && !timeline.clips.some((clip) => clip.room) },
    hook: { icon: <SparkIcon />, onClick: () => setSheet("hook"), disabled: !hasClips, pressed: timeline.hook !== null || timeline.texts.some((t) => t.id.startsWith("hook-word-")) },
    details: { icon: <DetailsIcon />, onClick: () => setSheet("details") },
    caption: { icon: <CaptionIcon />, onClick: () => setSheet("caption") },
    logo: { icon: <LogoIcon />, onClick: () => setSheet("logo"), disabled: !hasClips, pressed: timeline.logo !== null },
    plan: { icon: <PlanIcon />, onClick: () => setSheet("plan") },
    "ai-video": { icon: <MotionIcon />, onClick: () => setSheet("ai-video") },
    director: { icon: <AskIcon />, onClick: () => setSheet("director"), disabled: !hasClips },
    split: { icon: <SplitIcon />, onClick: split, disabled: !hasClips },
    guides: { icon: <GuidesIcon />, onClick: () => setGuides(!guides), pressed: guides },
    "delete-reel": {
      icon: <TrashIcon />,
      danger: true,
      onClick: async () => {
        if (!window.confirm(`Delete "${title}"? Its exports are deleted too. Uploaded media stays in your library.`)) return;
        const form = new FormData();
        form.set("id", reel.id);
        await deleteReel(form);
      },
    },
    // A title
    "text-edit": { icon: <EditIcon />, onClick: () => setSheet("text-edit") },
    particles: { icon: <SparkIcon />, onClick: () => setSheet("text-particles"), pressed: Boolean(selectedText?.particles) },
    "walk-through": { icon: <MoveRightIcon />, onClick: () => setSheet("text-walk"), pressed: Boolean(selectedText?.behind) },
    pin: { icon: <MotionIcon />, onClick: () => setSheet("pin"), pressed: Boolean(selectedText?.path && selectedText.path.length > 2) },
    timing: { icon: <ClockIcon />, onClick: () => setSheet("timing") },
    // The music
    "music-adjust": { icon: <VolumeIcon />, onClick: () => setSheet("music") },
    "music-replace": { icon: <SwapIcon />, onClick: () => setSheet("music") },
    "music-suggest": { icon: <SparkIcon />, onClick: () => setSheet("review-music") },
    // The presenter
    "redo-take": { icon: <SwapIcon />, onClick: () => setSheet("presenter") },
    "new-take": { icon: <PlusIcon />, onClick: () => setSheet("presenter") },
  };
  if (selectedClip) {
    const index = selectedClipIndex;
    const isVideo = selectedClip.kind === "VIDEO";
    Object.assign(handlers, {
      trim: { icon: isVideo ? <TrimIcon /> : <ClockIcon />, onClick: () => setSheet("trim") },
      speed: { icon: <SpeedIcon />, onClick: () => setSheet("speed") },
      zoom: { icon: <ZoomIcon />, onClick: () => setSheet("zoom") },
      replace: { icon: <SwapIcon />, onClick: () => setSheet("replace") },
      volume: { icon: <VolumeIcon />, onClick: () => setSheet("volume") },
      pano: { icon: <PanoIcon />, onClick: () => setSheet("pano") },
      motion: { icon: <MotionIcon />, onClick: () => setSheet("motion") },
      look: { icon: <FilterIcon />, onClick: () => setSheet("look") },
      cover: {
        icon: <CoverIcon />,
        pressed: timeline.cover?.clipId === selectedClip.id,
        onClick: () => {
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
        },
      },
      fit: { icon: <FitIcon />, onClick: () => apply((current) => updateClip(current, selectedClip.id, { fit: selectedClip.fit === "cover" ? "contain" : "cover" })) },
      transition: { icon: <TransitionIcon />, onClick: () => setSheet("transition"), disabled: index === 0 },
      duplicate: { icon: <DuplicateIcon />, onClick: () => runCommand({ type: "duplicateClip", clipId: selectedClip.id, newId: newId() }) },
      earlier: { icon: <MoveLeftIcon />, onClick: () => runCommand({ type: "moveClip", clipId: selectedClip.id, toIndex: index - 1 }), disabled: index === 0 },
      later: { icon: <MoveRightIcon />, onClick: () => runCommand({ type: "moveClip", clipId: selectedClip.id, toIndex: index + 1 }), disabled: index === timeline.clips.length - 1 },
      split: { icon: <SplitIcon />, onClick: split },
    } satisfies Record<string, ControlHandler>);
  }
  /** A control as a tool button: built-ins by their handler, extensions open their panel in a sheet. */
  const renderControl = (control: ResolvedControl) => {
    const handler = handlers[control.id];
    if (handler) {
      return (
        <Tool key={control.id} label={control.label} ariaLabel={control.ariaLabel} onClick={handler.onClick} pressed={handler.pressed} disabled={handler.disabled} danger={handler.danger}>
          {handler.icon}
        </Tool>
      );
    }
    if (EXTENSION_CONTROLS.some((extension) => extension.id === control.id)) {
      return (
        <Tool key={control.id} label={control.label} onClick={() => setSheet(`ext:${control.id}`)}>
          <SparkIcon />
        </Tool>
      );
    }
    return null;
  };
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
  const tools = controls.filter((control) => control.place === "bar").map(renderControl);
  const moreControls = controls.filter((control) => control.place === "more");
  // Ask is scoped by what is selected: the request names it, so the change lands on that thing.
  const askScope = selectedText
    ? { placeholder: "Change this title…", prefix: `About the title “${selectedText.text.replace(/\s+/g, " ").slice(0, 60)}”: ` }
    : selectedClip
      ? { placeholder: "Change this shot…", prefix: `About shot ${selectedClipIndex + 1}${selectedClip.room ? ` (the ${selectedClip.room})` : ""}: ` }
      : musicSelected
        ? { placeholder: "Change the music…", prefix: "About the music: " }
        : { placeholder: "Change anything…", prefix: "" };
  const activeExtension = sheet?.startsWith("ext:") ? EXTENSION_CONTROLS.find((extension) => `ext:${extension.id}` === sheet) : undefined;

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
        <div className="editor-top-actions">
          <button type="button" className="btn btn-quiet" onClick={openCheck} disabled={!hasClips} data-testid="check-button">
            Check
          </button>
          <button type="button" className="btn btn-signal" onClick={openExport} disabled={!hasClips} data-testid="export-button">
            Export
          </button>
        </div>
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
        onSurfaceText={(id, quad, gesture) => apply((current) => {
          const surface = orientQuad(quad).map(storedFraction);
          const text = current.texts.find((item) => item.id === id);
          // Pinned: the plane and every keyframe move with the corner, no re-tracking (ADR 0044).
          const reshaped = text ? reshapePin(text, surface) : null;
          return updateText(current, id, { surface, ...(reshaped ? { pin: reshaped.pin, path: reshaped.path } : {}) });
        }, gesture)}
        onBarsText={(id, bars, gesture) => apply((current) => updateText(current, id, { bars: bars.length ? bars : undefined }), gesture)}
        onCutoutsText={(id, cutouts, gesture) => apply((current) => updateText(current, id, { cutouts: cutouts.length ? cutouts : undefined }), gesture)}
        onOccludersText={(id, occluders, gesture) => apply((current) => updateText(current, id, { occluders: occluders.length ? occluders : undefined }), gesture)}
        onBehindText={(id, behind) => apply((current) => updateText(current, id, { behind: behind || undefined }), `behind-${id}`)}
        // Moving a callout's point drops its pin: the track followed the old point (ADR 0061).
        onCalloutAnchorText={(id, x, y, gesture) => apply((current) => updateText(current, id, { callout: { x, y }, path: undefined, pin: undefined }), gesture)}
        check={checking ? { marks: checkMarks, onSeek: seek } : null}
        corners={placing}
        onDoneCorners={exitTheater}
        placing={placing && placingShot ? { marks: placingShot.marks, onSeek: seek, onTrack: trackInPlace, status: placingStatus.text, busy: placingStatus.busy } : null}
        onResizeText={(id, size, gesture) => apply((current) => updateText(current, id, { size }), gesture)}
        onSelectText={(id) => setSelection({ kind: "text", id })}
        onEditText={(id) => {
          setSelection({ kind: "text", id });
          setSheet("text-edit");
        }}
        theater={theater}
        onExitTheater={exitTheater}
        inspect={inspecting ? { sources: inspectSources, totalMs, onSeek: seek, onClose: exitTheater } : null}
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
        <button type="button" className="icon-btn" aria-label="Inspect: magnify the frame" title="Inspect (I)" disabled={!hasClips} onClick={openInspect} data-testid="inspect-button">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6" />
            <path d="M15 15l5 5M8 10.5h5M10.5 8v5" />
          </svg>
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
        onMoveClip={(id, toIndex) => runCommand({ type: "moveClip", clipId: id, toIndex })}
        onClipTrim={(id, window, gesture) => runCommand({ type: "trimClip", clipId: id, window }, gesture)}
        onAddMedia={() => setSheet("media")}
        onAddText={() => setSheet("text-new")}
        onAddMusic={() => setSheet("music")}
        onPresenter={() => setSheet("presenter")}
        presenterReady={scriptRun.toPlace.length > 0}
      />

      <div className="editor-bottom">
        {askAvailable && hasClips ? (
          <AskBox
            placeholder={askScope.placeholder}
            onSend={(request) => {
              playerRef.current?.pause();
              // Hook lines are the Hook studio's to offer, where one tap puts the line into the opening (ADR 0068).
              const hooks = hookTextRequest(request);
              if (hooks) {
                setHookLines(hooks.count);
                setSheet("hook");
                return;
              }
              setAskSeed({ request: askScope.prefix + request, auto: true });
              setSheet("ask");
            }}
            onOpen={() => {
              setAskSeed(null);
              setSheet("ask");
            }}
          />
        ) : null}
        {polishable && askAvailable && !polishing && generation === polishable.draft.generation ? (
          <div className="polish-note">
            <button type="button" className="chip chip-btn" onClick={polishNow} disabled={aiUsage !== null && aiUsage.used >= aiUsage.allowed} data-testid="polish-ai">
              <SparkIcon size={16} />{" "}
              {aiUsage === null ? "Polish with AI" : aiUsage.used >= aiUsage.allowed ? "No AI polishes left this month" : `Polish with AI (uses 1 of ${aiUsage.allowed - aiUsage.used} left)`}
            </button>
          </div>
        ) : null}
        {polishing ? (
          <p className="polish-note muted small" role="status" data-testid="polishing">
            <span className="music-spinner" aria-hidden="true" /> Polishing with AI…
          </p>
        ) : null}
        <nav className="toolbar" aria-label="Editing tools">
          {selectionLead ? <span className="toolbar-context">{selectionLead}</span> : null}
          <div className="toolbar-scroll" ref={toolbarRef} onScroll={markToolbar}>
            {tools}
          </div>
          {selectionTail ? <span className="toolbar-end">{selectionTail}</span> : null}
        </nav>
      </div>
      </>

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
            // One gesture (one undo step, one baseline) for as long as the sheet is open, however long the slider rests.
            runCommand({ type: "trimClip", clipId: selectedClip.id, window }, `drag:trim-${selectedClip.id}:${sheetOpenedAt.current}`);
          }}
          onClose={closeSheet}
        />
      ) : null}
      {sheet === "speed" && selectedClip ? (
        <SpeedSheet clip={selectedClip} onChange={(speed) => runCommand({ type: "setSpeed", clipId: selectedClip.id, speed })} onClose={closeSheet} />
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
      {(sheet === "text-edit" || sheet === "text-particles" || sheet === "text-walk") && selectedText ? (
        <TextSheet initial={selectedText} playheadNow={clock.get} title={selectedText} music={timeline.music} focus={sheet === "text-particles" ? "particles" : sheet === "text-walk" ? "walk-through" : undefined} onSave={saveText} onClose={closeSheet} />
      ) : null}

      {sheet === "reel" ? (
        // Reel-wide settings, used now and then (ADR 0064): what the old toolbar and review carried, in one place.
        <Sheet title="This reel" onClose={closeSheet}>
          <div className="reel-controls" role="group" aria-label="Reel settings">
            {moreControls.map(renderControl)}
          </div>
          {autopilotPhase === "form" ? (
            <button type="button" className="btn btn-quiet btn-block" disabled={!hasClips} onClick={() => setSheet("autopilot")} data-testid="remake">
              Make it for me again: pick a style and the facts
            </button>
          ) : null}
        </Sheet>
      ) : null}

      {sheet === "replace" && selectedClip ? (
        <MediaSheet
          replace
          library={libraryList.filter((asset) => asset.id !== selectedClip.assetId)}
          onUpload={addFiles}
          onPick={([asset]) => {
            if (asset) apply((current) => replaceClipSource(current, selectedClip.id, asset));
            showToast("Clip replaced. Undo brings the old one back.");
            setSheet(null);
          }}
          onClose={closeSheet}
        />
      ) : null}

      {activeExtension ? (
        <Sheet title={activeExtension.title ?? (typeof activeExtension.label === "function" ? activeExtension.label(controlContext) : activeExtension.label)} onClose={closeSheet}>
          <activeExtension.Panel
            timeline={timeline}
            clip={selectedClip}
            text={selectedText}
            runCommand={runCommand}
            apply={apply}
            now={clock.get}
            seek={seek}
            toast={showToast}
            onClose={closeSheet}
          />
        </Sheet>
      ) : null}
      {sheet === "pin" && selectedText ? (() => {
        const at = locate(timeline, selectedText.startMs);
        const clip = at ? timeline.clips[at.index] : null;
        return <PinSheet text={selectedText} clip={clip} asset={clip ? library[clip.assetId] : undefined} clipStartMs={at ? selectedText.startMs - at.offsetMs : 0}
          placementVersionNow={() => placementVersion(timelineNow.current, selectedText.id)}
          onPath={(pinned, patch) => apply((current) => updateText(current, selectedText.id, { path: pinned?.path, pin: pinned?.pin, ...(patch ?? {}) }), `pin-${selectedText.id}`)}
          onSurface={(surface) => apply((current) => updateText(current, selectedText.id, { surface, path: undefined, pin: undefined, ...(surface ? {} : { bars: undefined, cutouts: undefined, occluders: undefined }) }), `surface-${selectedText.id}`)}
          onBars={(bars) => apply((current) => updateText(current, selectedText.id, { bars: bars.length ? bars : undefined }), `bars-${selectedText.id}`)}
          onCheck={openCheck} onPlaceCorners={() => openCorners("corners")} onDrawCutout={() => openCorners("cutouts")} onClose={closeSheet} />;
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
          onPick={(asset) => runCommand({ type: "setMusic", music: { assetId: asset.id, sourceStartMs: 0, ...songFields(asset) } })}
          beat={timeline.music?.bpm ? (
            <BeatControl
              music={timeline.music}
              measuring={beatMeasuring}
              onEnergy={(energy) => {
                measureForPace();
                const music = snapshot().timeline.music;
                // One drag across the stops is one undo step, planned from the reel before it (ADR 0059).
                const result = runCommand({ type: "pace", energy, clipEnergy: { ...clipEnergies.current }, songMap: music ? songMaps.current[music.assetId] : undefined, speechAssetIds: speechAssetIds(libraryRef.current) }, "pace");
                // A song shorter than the reel leaves the end silent: say so once.
                const past = pastSongEndMs(result.timeline, music ? libraryRef.current[music.assetId]?.durationMs : null);
                if (past >= 500 && !pastSongWarned.current) showToast(`The reel runs ${(past / 1000).toFixed(1)} s past the end of the song.`, 4000);
                pastSongWarned.current = past >= 500;
              }}
              onOnBeat={(on) => {
                runCommand({ type: "setOnBeat", on, speechAssetIds: speechAssetIds(libraryRef.current) });
                showToast(on ? "Titles, bursts and whips on the beat." : "On the beat is off.");
              }}
            />
          ) : null}
          onSnap={() => {
            // Titles and room names follow their clips to the new cut points (retimeTexts).
            runCommand({ type: "snapToBeat" });
            showToast("Cuts moved onto the beat.");
            setSheet(null);
          }}
          onUpload={uploadMusic}
          onChange={(patch) => apply((current) => (current.music ? setMusic(current, { ...current.music, ...patch }) : current), "music")}
          onRemove={deleteSelection}
          onClose={closeSheet}
          popular={{ moods: reelMoods(reelMoodInput(timeline, title)), reelMs: totalMs }}
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
          studio={
            <HookStudio
              timeline={timeline}
              assets={assets}
              library={library}
              reelId={reel.id}
              headline={headline}
              wantLines={hookLines}
              onApply={(command) => !runCommand(command, "hook-studio").rejected}
              onClose={closeSheet}
            />
          }
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
          initialRequest={askSeed?.request}
          autoSubmit={askSeed?.auto}
          onDirector={() => setSheet("director")}
          briefs={briefs}
          fresh={isFresh(timeline)}
          onAsk={async (request, answers) => {
            // The editor's own copy of the timeline goes along, so unsaved work counts; the answer is a proposal against its generation (ADR 0048).
            const base = snapshot();
            const data = await runAiJob<
              | { ok: true; timeline: unknown; note: string; applied: string[]; skipped: string[]; questions: string[]; assets?: LibraryAsset[]; instagramPick?: InstagramAudioTrack; caption?: string }
              | { ok: false; message: string; upgrade?: boolean }
            >(`/api/reels/${reel.id}/ai-edit`, { request, timeline: base.timeline, answers });
            if (!data.ok) return data;
            // A song or shot the AI brought in joins the library first, so the preview can play it.
            if (data.assets?.length) setLibrary((current) => ({ ...current, ...Object.fromEntries(data.assets!.map((asset) => [asset.id, asset])) }));
            if (data.applied.length > 0) {
              // The edit and the Instagram sound it chose (snapped to) are one undo step; stale or invalid, nothing changes.
              const landed = await landProposal(proposalDeps, base.generation, data.timeline, data.instagramPick);
              if (!landed.ok) return { ok: false, message: landed.message };
              showToast(data.note, 6000);
              setSheet(null);
            }
            // A caption written for the post is kept with the reel (it is not part of the edit).
            if (data.caption) {
              setCaption(data.caption);
              void saveCaption({ id: reel.id, caption: data.caption }).catch(() => undefined);
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

      {sheet === "director" ? <DirectorSheet reelId={reel.id} timeline={timeline} generation={generation} library={libraryList} onClose={closeSheet} onAssets={(assets) => setLibrary((current) => ({ ...current, ...Object.fromEntries(assets.map((asset) => [asset.id, asset])) }))} onApply={async (review) => {
        if (review.assets.length) setLibrary(current => ({ ...current, ...Object.fromEntries(review.assets.map(asset => [asset.id, asset])) }));
        // The plan may have chosen an Instagram sound; like the ask flow, it lands in the same step as the edit, so the reel actually has music.
        const landed = await landProposal(proposalDeps, reviewGeneration({ snapshot }, review), review.timeline, review.instagramPick);
        if (!landed.ok) return landed;
        if (review.plan.edit.caption) {
          setCaption(review.plan.edit.caption);
          void saveCaption({ id: reel.id, caption: review.plan.edit.caption }).catch(() => undefined);
        }
        showToast("Applied Opus's proposed edit. Undo takes it back.");
        return landed;
      }} /> : null}

      {sheet === "presenter" ? <Sheet title="Presenter" onClose={closeSheet}>
        <ScriptSheet reelId={reel.id} timeline={timeline} library={library} run={scriptRun}
          onAssets={(assets) => setLibrary((current) => ({ ...current, ...Object.fromEntries(assets.map((asset) => [asset.id, asset])) }))}
          onPlace={(takes, assets) => {
            setLibrary((current) => ({ ...current, ...Object.fromEntries(assets.map((asset) => [asset.id, asset])) }));
            // Every take in one command: one undo step takes the whole script back out (ADR 0048).
            const result = runCommand({ type: "insertPresenterTakes", takes });
            if (result.rejected) return false;
            showToast(result.changes.length ? `Placed ${takes.length === 1 ? "the take" : `${takes.length} takes`}. Undo takes them back out.` : "Those takes are already in the reel.");
            setSheet(null);
            return true;
          }} />
      </Sheet> : null}

      {sheet === "review-timing" ? (
        <TimingChoices
          timeline={timeline}
          onPace={(shotMs) => runCommand({ type: "retime", shotMs })}
          onLength={(totalMs) => runCommand({ type: "retimeToLength", totalMs })}
          onClose={closeSheet}
        />
      ) : null}
      {sheet === "review-look" ? (
        <LookChoices
          timeline={timeline}
          onLook={(filter) => apply((current) => setLook(current, filter))}
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
            apply((current) => updateText(current, id, { text }));
            showToast("Text changed.");
          }}
          onRoomLabels={(on) => apply((current) => (on ? addRoomLabels(current) : removeRoomLabels(current)))}
          onClose={closeSheet}
        />
      ) : null}
      {sheet === "review-music" ? (
        <MusicChoices
          reelId={reel.id}
          currentAudioId={timeline.music?.instagramAudioId ?? null}
          busyId={instagramBusy}
          onPick={async (track) => {
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
          // The critic's safe-zone check measures each title's box, so the export check's centre-point warning would repeat it.
          // Room labels are the exception: the critic leaves them to the editor, which redraws them.
          // Only while the panel shows (a reel that can export): with a blocking problem the panel is hidden and the warning stays.
          issues={critic.failed || !canExport(issues) ? issues : issues.filter((issue) => issue.code !== "text-unsafe" || issue.textId?.startsWith("room-"))}
          findingCount={critic.findings.length}
          critic={
            <CriticPanel findings={critic.findings} thumbs={critic.thumbs} checking={critic.checking} safeCount={criticSafeCount}
              onFix={applyCriticFix} onFixAll={fixAllCritic} onShow={showFinding} />
          }
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
