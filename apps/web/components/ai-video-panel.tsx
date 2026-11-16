"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AI_CAMERA_MOVE_RECIPES, AI_DRAFT_CREDITS, MOVES, MOVE_GROUPS, MOVE_GROUP_LABELS, aiFinalCredits, isCameraMove, moveById, movePrompt, AI_SHOT_LABELS, AI_SHOT_MODES, AI_SHOT_STYLES, AI_SHOT_STYLE_LABELS, AI_SHOT_ATMOSPHERES, AI_SHOT_ATMOSPHERE_LABELS,
  aiBoundary, aiClipCredits, aiConnectsClips, aiDefaultClipSeconds, aiShotSchema, aiShotStyle, type AiShot, type MoveId, type AiShotMode, type AiShotStyle, type AiShotAtmosphere, type Clip } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { CAMERA_KEYFRAME_MOVES, cameraKeyframeVideoPrompt, DEFAULT_SHOT_CINEMATOGRAPHY, type ShotCinematography, type ShotFramePair, type CameraKeyframeMove, type CameraKeyframeInput } from "@reelwalk/core";
import { GuidedFramePairPanel } from "./guided-frame-pair-panel";
import { framePairIntent, framePairMatches } from "./guided-frame-pair";
import { ShotGenerationProgress } from "./shot-generation-progress";
import { FurnitureStagePanel } from "./furniture-stage-panel";
import { DEFAULT_FURNITURE_STAGE, furnitureConceptInput } from "./furniture-stage";
import { keyframeInputKey } from "./shot-keyframe-panel";
import { CameraSketchControl } from "./camera-sketch-control";
import { cameraSketchIntent, type CameraSketch } from "./camera-sketch";
import { CameraDistanceInput } from "./camera-distance-input";
import { ShotSourcePicker } from "./shot-source-picker";
import { ShotKeyframePanel } from "./shot-keyframe-panel";
import { shotBuilderDraftSchema, shotBuilderRecoveryKey } from "./shot-builder-draft";
import { shotCardPayloadSchema } from "./shot-card-request";
import styles from "./shot-workspace.module.css";
import { uploadFile } from "./editor/upload";
import { shotFramePhoto } from "./shot-frame-photo";
import { AI_QUEUE_LIMIT, queueLabel, type QueuePosition, type TakeTrim } from "@reelwalk/core";

type Job = { id: string; requestId?: string; createdAt?: string; prompt: string; status: string; error: string | null; asset: LibraryAsset | null; shot: unknown; draftId: string | null;
  /** The take queue and the gate's measurements (ADR 0069). */
  queue?: QueuePosition | null; faceHeightPx?: number | null; framing?: string | null; take?: TakeTrim | null;
  /** Credits this take used, its length, and the final made from it when it is a draft (ADR 0076). */
  credits?: number; durationSeconds?: number; finalId?: string | null };
type State = { enabled: boolean; balance: { remaining: number; monthly: number; trial: number; topUp: number }; jobs: Job[] };
const active = (job: Job) => ["QUEUED", "SUBMITTING", "RUNNING"].includes(job.status);
const DEFAULT_PROMPT = "Make the sequence flow naturally and keep the referenced property's identity recognisable.";
const tierOf = (job: Job): "draft" | "final" | null => { const tier = (job.shot as { tier?: string } | null)?.tier; return tier === "draft" || tier === "final" ? tier : null; };

export function AiVideoPanel({ card, onCardRecovery, onCardDraft, onCardRequest, onCardPair, photos, clips = [], selectedClip, reelId, beforeGenerate, onAdd, onLibraryAsset, initialMove = null }: {
  card?: import("@reelwalk/core").ShotCard;
  onCardRecovery?(key: string, value: string): Promise<boolean>;
  onCardDraft?(draft: string, frameAssetIds: string[]): void;
  onCardRequest?(request: NonNullable<import("@reelwalk/core").ShotCard["request"]>): Promise<boolean>;
  onCardPair?(pair: ShotFramePair, expectedId?: string, expectedEndRequestId?: string): Promise<boolean>;
  photos: LibraryAsset[]; clips?: Clip[]; selectedClip?: Clip | null; reelId?: string;
  /** A camera move the Moves sheet chose (ADR 0076): selected, with its words in the prompt. */
  initialMove?: MoveId | null;
  beforeGenerate?(): Promise<boolean>; onAdd?(asset: LibraryAsset, shot?: AiShot, jobId?: string, durationSeconds?: number): void;
  onLibraryAsset?(asset: LibraryAsset): void;
}) {
  const [state, setState] = useState<State | null>(null);
  const [prompt, setPrompt] = useState(initialMove ? movePrompt(initialMove) : DEFAULT_PROMPT);
  const [move, setMove] = useState<MoveId | "">(initialMove ?? "");
  const [quality, setQuality] = useState<"draft" | "final">("final");
  const [mode, setMode] = useState<AiShotMode>(selectedClip?.kind === "VIDEO" ? "continue" : selectedClip?.kind === "IMAGE" ? "gimbal" : "custom");
  const [photo, setPhoto] = useState(selectedClip ? `clip:${selectedClip.id}` : "");
  const [last, setLast] = useState("");
  const [firstMs, setFirstMs] = useState(0);
  const [lastMs, setLastMs] = useState(0);
  const [draft, setDraft] = useState(false);
  const [style, setStyle] = useState<AiShotStyle>("source");
  const [atmosphere, setAtmosphere] = useState<AiShotAtmosphere>("source");
  const [energy, setEnergy] = useState<"subtle" | "bold">("subtle");
  const [harmonize, setHarmonize] = useState(false);
  const [polish, setPolish] = useState(false);
  const [useEndReference, setUseEndReference] = useState(false);
  // null follows the shot type: 8 s for timelapses, 4 s for everything else.
  const [chosenSeconds, setChosenSeconds] = useState<4 | 8 | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extraPhotos, setExtraPhotos] = useState<Record<string, LibraryAsset>>({});
  const [direction, setDirection] = useState<CameraKeyframeMove | null>(initialMove ? null : "push-in");
  const [furnitureStage, setFurnitureStage] = useState<import("@reelwalk/core").FurnitureStage>();
  const [furnitureSource, setFurnitureSource] = useState("");
  const [furnitureSelection, setFurnitureSelection] = useState<import("zod").infer<typeof shotBuilderDraftSchema>["furnitureSelection"]>();
  const [furnitureBlocked, setFurnitureBlocked] = useState(false);
  const [cameraSketch, setCameraSketch] = useState<CameraSketch>();
  const [startOnly, setStartOnly] = useState(false);
  const [reviewedStart, setReviewedStart] = useState<string>();
  const [reviewImagesLoaded, setReviewImagesLoaded] = useState<Record<string, boolean>>({});
  const [distanceM, setDistanceM] = useState(1);
  const [distanceValid, setDistanceValid] = useState(true);
  const [frameNotes, setFrameNotes] = useState("");
  const [startBase, setStartBase] = useState(selectedClip ? `clip:${selectedClip.id}` : "");
  const [endBase, setEndBase] = useState("");
  const [generatedStart, setGeneratedStart] = useState(false), [generatedEnd, setGeneratedEnd] = useState(false);
  const [workflow, setWorkflow] = useState<"guided" | "manual">();
  const [cinematography, setCinematography] = useState<ShotCinematography>();
  const [reviewedPair, setReviewedPair] = useState<import("zod").infer<typeof shotBuilderDraftSchema>["reviewedPair"]>();
  const [lastCheckedAt, setLastCheckedAt] = useState<string>();
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [startImageBlocked, setStartImageBlocked] = useState(false), [endImageBlocked, setEndImageBlocked] = useState(false);
  const receiveBalance = useCallback((remaining: number) => setState(old => old && old.balance.remaining !== remaining ? { ...old, balance: { ...old.balance, remaining } } : old), []);
  const receiveAssets = useCallback((assets: LibraryAsset[]) => setExtraPhotos(old => {
    if (!assets.some(asset => !old[asset.id] || old[asset.id].url !== asset.url)) return old;
    return { ...old, ...Object.fromEntries(assets.map(asset => [asset.id, asset])) };
  }), []);
  const allPhotos = [...photos.filter(asset => !extraPhotos[asset.id]), ...Object.values(extraPhotos)];
  const [draftLoaded, setDraftLoaded] = useState(false), [recoveryError, setRecoveryError] = useState("");
  const recoveryKey = shotBuilderRecoveryKey(reelId, card?.id ?? selectedClip?.id);
  const mediaLock = useRef(false), alive = useRef(true), scope = useRef(recoveryKey);
  scope.current = recoveryKey;
  const [mediaProgress, setMediaProgress] = useState<string | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    setDraftLoaded(false);
    try {
      const value = card ? card.draft : localStorage.getItem(recoveryKey);
      if (!value) {
        setFurnitureStage(undefined); setFurnitureSource(""); setFurnitureSelection(undefined); setFurnitureBlocked(false);
        setCameraSketch(undefined); setStartOnly(false); setReviewedStart(undefined);
        setWorkflow(undefined); setCinematography(undefined); setReviewedPair(undefined);
        const start = card?.sourceAssetId ? `asset:${card.sourceAssetId}` : selectedClip ? `clip:${selectedClip.id}` : "";
        setPhoto(start); setStartBase(start); setLast(""); setEndBase(""); setFirstMs(0); setLastMs(0);
        setGeneratedStart(false); setGeneratedEnd(false); setUseEndReference(false);
        setDirection(initialMove ? null : "push-in"); setDistanceM(1); setChosenSeconds(null); setFrameNotes("");
        setPrompt(initialMove ? movePrompt(initialMove) : DEFAULT_PROMPT); setMove(initialMove ?? "");
        setMode(selectedClip?.kind === "VIDEO" ? "continue" : selectedClip?.kind === "IMAGE" ? "gimbal" : "custom");
        setQuality("final"); setStyle("source"); setAtmosphere("source"); setEnergy("subtle"); setHarmonize(false); setPolish(false); setDraft(false);
      } else {
        const saved = shotBuilderDraftSchema.parse(JSON.parse(value));
        setFurnitureStage(saved.furnitureStage); setFurnitureSource(saved.furnitureSource ?? ""); setFurnitureSelection(saved.furnitureSelection);
        setCameraSketch(saved.cameraSketch); setStartOnly(saved.startOnly ?? false); setReviewedStart(saved.reviewedStart);
        setWorkflow(saved.workflow); setCinematography(saved.cinematography); setReviewedPair(saved.reviewedPair);
        setPhoto(saved.photo); setLast(saved.last); setStartBase(saved.startBase); setEndBase(saved.endBase);
        setFirstMs(saved.firstMs); setLastMs(saved.lastMs); setGeneratedStart(saved.generatedStart); setGeneratedEnd(saved.generatedEnd);
        setUseEndReference(saved.useEndReference); setDirection(saved.direction); setDistanceM(saved.distanceM); setChosenSeconds(saved.chosenSeconds);
        setFrameNotes(saved.frameNotes); setPrompt(saved.prompt); setMode(saved.mode); setMove(saved.move); setQuality(saved.quality);
        setStyle(saved.style); setAtmosphere(saved.atmosphere); setEnergy(saved.energy); setHarmonize(saved.harmonize); setPolish(saved.polish); setDraft(saved.draft);
      }
    } catch { setRecoveryError("Saved shot choices could not reopen. Your generated images remain in the library."); }
    finally { setDraftLoaded(true); }
  }, [recoveryKey]);
  useEffect(() => {
    if (!draftLoaded) return;
    try {
      const serialized = JSON.stringify({ version: 1, photo, last, startBase, endBase, firstMs, lastMs, generatedStart, generatedEnd, useEndReference,
        direction, distanceM, chosenSeconds, frameNotes, prompt, mode, move, quality, style, atmosphere, energy, harmonize, polish, draft,
        ...(furnitureStage ? { furnitureStage } : {}), ...(furnitureSource ? { furnitureSource } : {}), ...(furnitureSelection ? { furnitureSelection } : {}), ...(cameraSketch ? { cameraSketch } : {}), ...(startOnly ? { startOnly } : {}), ...(reviewedStart ? { reviewedStart } : {}), ...(workflow ? { workflow } : {}), ...(cinematography ? { cinematography } : {}), ...(reviewedPair ? { reviewedPair } : {}) });
      if (card) onCardDraft?.(serialized, [photo, last, startBase, endBase, furnitureSource, ...(furnitureSelection ? [`asset:${furnitureSelection.assetId}`] : [])].filter(value => value.startsWith("asset:")).map(value => value.slice(6)));
      else localStorage.setItem(recoveryKey, serialized);
    } catch { setRecoveryError("This browser could not save the shot choices. Keep this tab open; generated images are still saved on the server."); }
  }, [draftLoaded, recoveryKey, photo, last, startBase, endBase, firstMs, lastMs, generatedStart, generatedEnd, useEndReference, direction, distanceM, chosenSeconds, frameNotes, prompt, mode, move, quality, style, atmosphere, energy, harmonize, polish, draft, workflow, cinematography, reviewedPair, cameraSketch, startOnly, reviewedStart, furnitureStage, furnitureSource, furnitureSelection]);
  const requestId = useRef<string | null>(card?.request?.id ?? null);
  const requestSignature = useRef("");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/ai/generations${card?.request ? `?requestId=${encodeURIComponent(card.request.id)}` : ""}`, { cache: "no-store", signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load AI clips.");
    if (card?.request && onCardRequest) {
      const found = data.jobs.find((job: Job) => job.requestId === card.request!.id);
      if (found && found.id !== card.request.jobId) await onCardRequest({ ...card.request, jobId: found.id });
    }
    setState(data); setLastCheckedAt(new Date().toISOString()); setConnectionError(null);
    return data as State;
  }, [card?.request?.id]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch(e => { if (!controller.signal.aborted) { setError(e.message); setConnectionError("Your saved request is retained. Refresh status when connected."); } });
    return () => controller.abort();
  }, [refresh]);

  const running = state?.jobs.some(active) ?? false;
  useEffect(() => {
    if (!running) return;
    const controller = new AbortController();
    const timer = setInterval(() => { void refresh(controller.signal).catch(() => { if (!controller.signal.aborted) setConnectionError("Progress could not refresh. No new request has been submitted."); }); }, 5000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [running, refresh]);

  const bridge = aiConnectsClips(mode);
  // Existing paid requests and per-frame recovery keep their original manual path and draft bytes.
  const guided = !!card && !!onCardPair && !card.request && !bridge && !startOnly && (workflow === "guided" || workflow !== "manual" && (!card.recovery || Object.keys(card.recovery).length === 0));
  const seconds = chosenSeconds ?? aiDefaultClipSeconds(mode, move || undefined);
  // A draft (ADR 0076) is a Lite 720p preview from a starting frame; credits are whole, so it is one credit whatever the length.
  const noDraft = bridge || useEndReference ? "A draft is made from a starting frame only." : null;
  const draftMode = quality === "draft" && !noDraft;
  const credits = draftMode ? AI_DRAFT_CREDITS : aiClipCredits(seconds);
  const camera = mode === "gimbal" || mode === "drone";
  const anchor = photo.startsWith("clip:") ? clips.find(c => c.id === photo.slice(5)) : undefined;
  const next = last.startsWith("clip:") ? clips.find(c => c.id === last.slice(5)) : undefined;
  function source(value: string, end: boolean, atMs: number) {
    if (value.startsWith("clip:")) {
      const clip = clips.find(c => c.id === value.slice(5));
      return clip ? aiBoundary(clip, end) : undefined;
    }
    return value.startsWith("asset:") ? { assetId: value.slice(6), atMs } : undefined;
  }
  const firstFrame = source(photo, true, firstMs);
  const lastFrame = bridge || !startOnly && useEndReference ? source(last, false, lastMs) : undefined;
  const assetFor = (frame: { assetId: string } | undefined) => allPhotos.find(asset => asset.id === frame?.assetId);
  const keyframeSource = (value: string, end: boolean) => {
    const frame = source(value, end, 0), asset = assetFor(frame);
    return frame && asset?.kind === "IMAGE" ? { assetId: frame.assetId, atMs: 0 as const } : undefined;
  };
  const startImageSource = keyframeSource(startBase, true);
  const endImageSource = endBase ? keyframeSource(endBase, false) : assetFor(firstFrame)?.kind === "IMAGE" && firstFrame ? { assetId: firstFrame.assetId, atMs: 0 as const } : undefined;
  const continuity = assetFor(firstFrame)?.kind === "IMAGE" && firstFrame ? { assetId: firstFrame.assetId, atMs: 0 as const } : undefined;
  const imageInput = (role: "start" | "end"): CameraKeyframeInput | null => {
    const frame = role === "start" ? startImageSource : endImageSource;
    return frame && direction && !bridge ? { role, source: frame, ...(role === "end" && continuity ? { continuity } : {}), move: direction, distanceM, durationSeconds: seconds, ...(frameNotes.trim() ? { prompt: frameNotes.trim() } : {}), ...(startOnly ? { cinematography: cinematography ?? DEFAULT_SHOT_CINEMATOGRAPHY } : {}) } : null;
  };
  const guidedInput: CameraKeyframeInput | null = startImageSource && direction && !bridge ? {
    role: "start", source: startImageSource, move: direction, distanceM, durationSeconds: seconds,
    ...(frameNotes.trim() ? { prompt: frameNotes.trim() } : {}), cinematography: cinematography ?? DEFAULT_SHOT_CINEMATOGRAPHY,
  } : null;
  const pairReviewed = !!reviewedPair && !!card?.framePair && reviewedPair.pairId === card.framePair.id
    && framePairMatches(card.framePair, guidedInput) && reviewedPair.inputKey === framePairIntent(guidedInput!)
    && reviewedPair.startAssetId === firstFrame?.assetId && reviewedPair.endAssetId === lastFrame?.assetId
    && reviewedPair.startAssetId === card.framePair.startAssetId
    && reviewedPair.endAssetId === (card.framePair.endRevision ? card.framePair.endRevision.assetId : card.framePair.endAssetId);
  const stagedStart = !!furnitureSelection && furnitureSelection.assetId === firstFrame?.assetId;
  const stagingMatches = !stagedStart || !!furnitureStage && furnitureSource === `asset:${furnitureSelection!.sourceAssetId}`
    && furnitureSelection!.inputKey === keyframeInputKey(furnitureConceptInput(furnitureSelection!.sourceAssetId, furnitureStage));
  const sketchValid = !cameraSketch || !!cameraSketchIntent(cameraSketch);
  const startReviewKey = JSON.stringify([firstFrame?.assetId, firstFrame?.atMs, startBase, direction, distanceM, seconds, frameNotes, cinematography ?? null, mode, prompt, style, atmosphere, energy, quality]);
  const startReviewed = !startOnly || reviewedStart === startReviewKey;
  const reviewSource = assetFor(source(startBase, true, 0));
  const reviewStart = assetFor(firstFrame);
  const reviewUrls = [reviewSource?.url, reviewStart?.url].filter((url): url is string => !!url);
  const startPreviewsReady = reviewUrls.length === 2 && reviewUrls.every(url => reviewImagesLoaded[url]);
  // The submitted prompt is derived synchronously from the controls being shown.
  const currentPrompt = direction && !bridge ? cameraKeyframeVideoPrompt({ role: "end", source: { assetId: "selected-source", atMs: 0 },
    move: direction, distanceM, durationSeconds: seconds, prompt: frameNotes.trim(), ...(guided || reviewedPair || startOnly ? { cinematography: cinematography ?? DEFAULT_SHOT_CINEMATOGRAPHY } : {}) }, !!lastFrame) : prompt;
  function resetGeneratedFrames() {
    setReviewedStart(undefined);
    setReviewedPair(undefined);
    if (generatedStart && !startOnly && !(guided && card?.framePair)) { setPhoto(startBase); setFirstMs(0); setGeneratedStart(false); }
    if (generatedEnd) { setLast(endBase); setLastMs(0); setGeneratedEnd(false); }
  }
  function chooseSource(ending: boolean, value: string) {
    setReviewedPair(undefined);
    if (ending) { setLast(value); setEndBase(value); setLastMs(0); setGeneratedEnd(false); setUseEndReference(!!value); }
    else {
      setPhoto(value); setStartBase(value); setFirstMs(0); setGeneratedStart(false);
      if (generatedEnd) { setLast(endBase); setLastMs(0); setGeneratedEnd(false); }
    }
  }
  function useImage(role: "start" | "end", asset: LibraryAsset) {
    receiveAssets([asset]);
    if (role === "start") {
      setPhoto(`asset:${asset.id}`); setFirstMs(0); setGeneratedStart(true);
      if (generatedEnd) { setLast(endBase); setLastMs(0); setGeneratedEnd(false); }
    } else { setLast(`asset:${asset.id}`); setLastMs(0); setUseEndReference(true); setGeneratedEnd(true); }
    setQuality("final"); requestId.current = null;
  }
  async function addReference(ending: boolean, file?: File) {
    if (busy || mediaLock.current) return;
    const originalScope = recoveryKey, frame = ending ? lastFrame : firstFrame, sourceAsset = assetFor(frame);
    mediaLock.current = true; setBusy(true); setError(null); setMediaProgress(file ? "Uploading photo…" : "Saving video frame…");
    try {
      const photoFile = file ?? (frame && sourceAsset?.kind === "VIDEO" ? await shotFramePhoto(sourceAsset.id, sourceAsset.fileName, frame.atMs) : null);
      if (!photoFile || !/\.(jpe?g|png)$/i.test(photoFile.name) || photoFile.type && !["image/jpeg", "image/png"].includes(photoFile.type) || photoFile.size > 20 * 1024 * 1024) throw Error("Choose a JPEG or PNG photo under 20 MB.");
      const asset = await uploadFile(photoFile, fraction => { if (alive.current) setMediaProgress(`Uploading photo… ${Math.round(fraction * 100)}%`); });
      onLibraryAsset?.(asset);
      if (!alive.current || scope.current !== originalScope) return;
      receiveAssets([asset]);
      if (asset.kind !== "IMAGE" || asset.isPano) throw Error("Choose a regular photo rather than a 360 image.");
      chooseSource(ending, `asset:${asset.id}`);
      if (!ending) setMode("custom");
    } catch (e) { if (alive.current && scope.current === originalScope) setError(e instanceof Error ? e.message : "Could not add this photo. Try again."); }
    finally { mediaLock.current = false; if (alive.current) { setBusy(false); setMediaProgress(null); } }
  }
  function picker(ending: boolean, original = false) {
    const value = original ? startBase : ending ? last : photo;
    return <ShotSourcePicker label={original ? "Reference photo" : ending ? "End" : "Start"} value={value} frame={original ? source(startBase, true, firstMs) : ending ? lastFrame : firstFrame}
      photos={allPhotos} clips={clips} allowVideos={!camera} allowNone disabled={busy} fullReference={original}
      onChange={value => chooseSource(ending, value)} onTimeChange={atMs => (ending ? setLastMs : setFirstMs)(atMs)}
      onUpload={file => void addReference(ending, file)} onSaveFrame={() => void addReference(ending)} />;
  }

  function videoPayload() {
    if (furnitureBlocked || !stagingMatches) throw Error("Finish reviewing the furniture concept or restore its accepted furnishing settings before video generation.");
    if (!sketchValid) throw Error("Separate the sketch positions before making the video.");
    if (startOnly && (!startReviewed || !startPreviewsReady)) throw Error("Compare the original and Start and confirm your manual property review.");
    if (direction !== null && !distanceValid) throw Error("Enter a valid camera distance before making the video.");
    if (guided && !pairReviewed) throw Error("Review and select both prepared frames before making the video.");
    if (!startOnly && useEndReference && !bridge && !lastFrame) throw Error("Choose an ending reference, or turn off ending guidance.");
    if (!guided && (startImageBlocked || !startOnly && endImageBlocked)) throw Error("Finish reviewing your prepared image before making the video.");
    const shot = aiShotSchema.safeParse({ mode, ...(move && !bridge && !direction ? { move } : {}), first: firstFrame, last: lastFrame, anchor, style, atmosphere, energy, harmonize: Boolean(onAdd) && !card && harmonize, polish: Boolean(onAdd) && !card && polish,
      next: anchor && lastFrame ? next : undefined, ...(!card && draft && anchor && reelId ? { draftReelId: reelId } : {}),
    });
    if (!shot.success) throw Error(shot.error.issues[0]?.message || "Choose source frames.");
    if (bridge && anchor && (!next || clips.indexOf(next) !== clips.indexOf(anchor) + 1)) {
      throw Error("Choose the shot immediately after the starting clip for a timeline bridge.");
    }
    const payload = shotCardPayloadSchema.safeParse({ prompt: currentPrompt, shot: shot.data, durationSeconds: seconds, ...(draftMode ? { quality: "draft" as const } : {}) });
    if (!payload.success) throw Error(payload.error.issues[0]?.message || "Check this shot's settings.");
    return payload.data;
  }

  async function submitVideo(payload: ReturnType<typeof videoPayload>, id: string) {
    const saved = { id, draft: card?.draft ?? "", payload: JSON.stringify(payload) };
    if (card && (!card.draft || !onCardRequest || !await onCardRequest(saved))) throw Error("Save this card and its request before generating.");
    const response = await fetch("/api/ai/generations", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: id, ...payload }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not start this shot.");
    if (card && onCardRequest && !await onCardRequest({ ...saved, jobId: result.id })) throw Error("The shot was submitted. Check the saved video request to recover it.");
    requestId.current = null;
    await refresh();
  }

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (busy || card?.request) return;
    setBusy(true);
    try {
      const payload = videoPayload();
      if (beforeGenerate && !await beforeGenerate()) throw new Error("Save your reel before generating this shot.");
      const signature = JSON.stringify(payload);
      if (signature !== requestSignature.current) { requestSignature.current = signature; requestId.current = null; }
      requestId.current ??= crypto.randomUUID();
      await submitVideo(payload, requestId.current);
    } catch (e) { setError(e instanceof Error ? e.message : "Connection interrupted. Try again to check this request."); }
    finally { setBusy(false); }
  }

  async function retrySavedRequest() {
    if (busy || !card?.request) return;
    setError(null); setBusy(true);
    try {
      const saved = card.request;
      const current = await refresh();
      if (current.jobs.some(job => job.requestId === saved.id)) return;
      if (saved.jobId || !saved.payload) throw Error("Keep this saved request and check its status again. Its original inputs cannot be safely retried.");
      const payload = shotCardPayloadSchema.parse(JSON.parse(saved.payload));
      if (saved.draft !== card.draft || JSON.stringify(payload) !== JSON.stringify(videoPayload())) throw Error("Restore the saved shot's frames and settings before retrying its request.");
      if (beforeGenerate && !await beforeGenerate()) throw Error("Save your reel before generating this shot.");
      await submitVideo(payload, saved.id);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not recover this request. Its identity has been retained."); }
    finally { setBusy(false); }
  }

  const finalCredits = (job: Job) => aiFinalCredits((job.durationSeconds ?? 4) as 4 | 8, Boolean((job.shot as AiShot).voice && (job.shot as AiShot).line), job.credits ?? AI_DRAFT_CREDITS);
  const videoJob = state?.jobs.find(job => card?.request ? job.requestId === card.request.id : active(job));

  /** "Make it final" (ADR 0076): the finished draft's prompt, frames and seed on the full model; the server reads them from the draft. */
  async function makeFinal(job: Job) {
    setError(null); setBusy(true);
    try {
      const response = await fetch("/api/ai/generations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: crypto.randomUUID(), prompt: job.prompt, finalOf: job.id }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not make this draft final.");
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Connection interrupted. Try again to check this request."); }
    finally { setBusy(false); }
  }

  const FrameGuidance = card ? "details" : "section";
  const directionControls = <section className={styles.direction} aria-label="Shot direction">
    <h3 className={styles.sectionTitle}>{guided && card?.framePair ? "Adjust End" : "Describe your shot first"}</h3>
    <CameraSketchControl value={cameraSketch} disabled={busy || bridge || !!card?.request} onChange={sketch => {
      resetGeneratedFrames(); setCameraSketch(sketch);
      const intent = cameraSketchIntent(sketch);
      if (intent) { setDirection(intent.move); setDistanceM(intent.distanceM); setMode("custom"); setMove(""); }
    }} />
    <label className="field">Camera move
      <select className="text-input" value={direction ?? "custom"} disabled={busy || bridge || !!card?.request} onChange={e => { resetGeneratedFrames(); setCameraSketch(undefined); setDirection(e.target.value === "custom" ? null : e.target.value as CameraKeyframeMove); if (e.target.value === "custom") setWorkflow("manual"); else setMove(""); setMode("custom"); requestId.current = null; }}>
        {CAMERA_KEYFRAME_MOVES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}<option value="custom">Custom direction</option>
      </select>
    </label>
    <CameraDistanceInput key={recoveryKey} value={distanceM} disabled={busy || !direction || bridge}
      onChange={value => { resetGeneratedFrames(); setCameraSketch(undefined); setDistanceM(value); }} onValidityChange={setDistanceValid} />
    <label className="field">Length<select className="text-input" value={seconds} disabled={busy} onChange={e => { resetGeneratedFrames(); setChosenSeconds(Number(e.target.value) as 4 | 8); }}>
      <option value={4}>4 seconds</option><option value={8}>8 seconds</option>
    </select></label>
    <label className="field">{guided && card?.framePair ? "How should End change?" : "What should happen?"}
      <span className="muted small">{guided && card?.framePair ? "Optional · Start stays unchanged" : "Optional · guides both frames"}</span>
      <textarea className="text-input" rows={3} maxLength={600} value={frameNotes} disabled={busy} placeholder="For example: rise further above the pool and finish at dusk. Keep the house unchanged."
        onChange={e => { resetGeneratedFrames(); setFrameNotes(e.target.value); }} />
    </label>
  </section>;

  return <div className={`ai-video-panel ${styles.workspace} ${card ? styles.shotWorkspace : ""}`}>
    <header className={styles.header}>
      {!card ? <p className={styles.intro}>{guided ? "One reference. Two prepared frames. Review them, then make your video." : "Choose the pictures, review your frames, then make the video."}</p> : null}
      <p className="ai-credit-count" role="status">{state ? `${state.balance.remaining} AI ${state.balance.remaining === 1 ? "credit" : "credits"} available` : "Loading your credits…"}</p>
    </header>
    {state && !state.enabled ? <p className="toast" role="status">AI video is being connected. Your credits are ready for when it opens.</p> : null}
    {recoveryError ? <p className="error small" role="status">{recoveryError}</p> : null}
    {card && error ? <div role="alert"><p className="error small">{error}</p>{connectionError ? <button type="button" className="btn" onClick={() => void refresh().then(() => setError("")).catch(e => setError(e.message))}>Retry video status</button> : null}</div> : null}
    {mediaProgress ? <p role="status">{mediaProgress}</p> : null}
    <form onSubmit={generate} className={`ai-video-form ${styles.form}`}>
      <div className={styles.layout}>
      <section className={styles.references} aria-label="Shot references" data-prepared={guided && !!card?.framePair || !!card?.request}>
        {!guided && !card?.request ? <h3 className={styles.sectionTitle}>Choose your frames</h3> : null}
        <div className={guided || card?.request ? styles.singleReference : styles.referencePair}>{guided || card?.request ? <details className={styles.compactReference} open={!startBase}>
          <summary>{assetFor(source(startBase, true, firstMs))?.kind === "IMAGE" ? <img src={assetFor(source(startBase, true, firstMs))!.url} alt="Reference thumbnail" /> : null}
            <span>Reference photo<span className="muted small">{startBase ? "Change photo" : "Choose or upload a photo"}</span></span>
          </summary>{picker(false, true)}</details> : <>{picker(false)}{picker(true)}</>}</div>
        {guided && assetFor(source(startBase, true, 0))?.kind === "VIDEO" ? <p className={styles.hint}>Save this frame as a photo to prepare Start and End from your video’s original detail.</p> : null}
      </section>
      {!card?.request && !(guided && card?.framePair) ? card ? <section className={styles.movement} aria-label="Movement">
        <label className="field">Movement<select className="text-input" value={direction ?? "custom"} disabled={busy || bridge || !!card.request} onChange={e => { resetGeneratedFrames(); setCameraSketch(undefined); setDirection(e.target.value === "custom" ? null : e.target.value as CameraKeyframeMove); if (e.target.value === "custom") setWorkflow("manual"); else setMove(""); setMode("custom"); requestId.current = null; }}>
          {CAMERA_KEYFRAME_MOVES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}<option value="custom">Custom direction</option>
        </select></label>
        <details className={styles.details}><summary>Adjust movement {"\u00b7"} {seconds}s</summary>{directionControls}</details>
      </section> : directionControls : null}
      {!bridge && !card?.request ? <details className={`${styles.details} ${styles.secondary}`} onToggle={event => {
        if (event.currentTarget.open && !furnitureStage) { setFurnitureStage(DEFAULT_FURNITURE_STAGE); setFurnitureSource(startBase.startsWith("asset:") ? startBase : ""); }
      }}><summary>Furniture concept: edit an area before camera movement</summary>
        {furnitureStage ? <FurnitureStagePanel photos={allPhotos} source={furnitureSource} stage={furnitureStage} disabled={busy || !draftLoaded}
          recoveryKey={recoveryKey} durableRecovery={card?.recovery} onRecovery={onCardRecovery} selectedAssetId={furnitureSelection?.assetId}
          onSource={setFurnitureSource} onChange={setFurnitureStage} onAssets={receiveAssets} onBalance={receiveBalance} onBlocked={setFurnitureBlocked}
          onUse={(asset, input) => {
            receiveAssets([asset]); setFurnitureSelection({ sourceAssetId: input.source.assetId, assetId: asset.id, inputKey: keyframeInputKey(input) });
            setStartBase(`asset:${input.source.assetId}`); setPhoto(`asset:${asset.id}`); setFirstMs(0); setGeneratedStart(true);
            setStartOnly(true); setUseEndReference(false); setWorkflow("manual"); setReviewedStart(undefined); setReviewedPair(undefined); setQuality("final"); requestId.current = null;
          }} onOriginal={input => {
            setFurnitureSelection(undefined); setStartBase(`asset:${input.source.assetId}`); setPhoto(`asset:${input.source.assetId}`); setFirstMs(0); setGeneratedStart(false);
            setStartOnly(true); setUseEndReference(false); setWorkflow("manual"); setReviewedStart(undefined); setReviewedPair(undefined);
          }} /> : null}
      </details> : null}
      {stagedStart ? <p className={styles.hint} role="status">Start uses an accepted AI furniture concept. The original photo is preserved. {stagingMatches ? "Camera direction below remains your own setting." : "Furnishing choices changed; restore the accepted settings or review a new concept before making video."}</p> : null}
      {!bridge && !card?.request ? <FrameGuidance className={`${styles.preparation} ${styles.secondary}`} aria-label="Frame guidance choice">{card ? <summary>Frame guidance</summary> : null}
        <label className="field">Frame guidance<select className="text-input" disabled={busy} value={startOnly ? "start" : "pair"} onChange={event => {
          setStartOnly(event.target.value === "start"); if (event.target.value === "pair" && card?.framePair) setWorkflow("guided"); setReviewedStart(undefined); setReviewedPair(undefined); requestId.current = null;
          if (event.target.value === "start") { setUseEndReference(false); setQuality("final"); }
        }}><option value="pair">Start and End</option><option value="start">Start only (no End generation)</option></select></label>
        <p className={styles.hint}>If End changes the roof, openings or materials, use a reviewed Start with a small move. Start-only does not prepare or retry an End. An already submitted pair keeps its existing requests and costs.</p>
      </FrameGuidance> : null}
      <section className={styles.preparation} aria-label="Review prepared images" hidden={!!card?.request}>
      {guided && onCardPair ? <GuidedFramePairPanel compact={!!card} pair={card?.framePair} input={guidedInput} reviewed={pairReviewed} disabled={busy || furnitureBlocked || !draftLoaded}
        onUseStart={asset => {
          receiveAssets([asset]); setPhoto(`asset:${asset.id}`); setFirstMs(0); setGeneratedStart(true);
          setStartOnly(true); setUseEndReference(false); setReviewedPair(undefined); setReviewedStart(undefined); setQuality("final"); requestId.current = null;
        }} endControls={card?.framePair ? directionControls : undefined} inputValid={distanceValid && sketchValid}
        onSave={onCardPair} onAssets={receiveAssets} onBalance={receiveBalance} beforePrepare={beforeGenerate}
        onReview={(start, end, pair) => {
          receiveAssets([start, end]); setPhoto(`asset:${start.id}`); setLast(`asset:${end.id}`); setFirstMs(0); setLastMs(0);
          setGeneratedStart(true); setGeneratedEnd(true); setUseEndReference(true); setQuality("final");
          setReviewedPair({ pairId: pair.id, inputKey: framePairIntent(guidedInput!), startAssetId: start.id, endAssetId: end.id });
          requestId.current = null;
        }} /> : <>
      {!imageInput("end") && assetFor(firstFrame)?.kind === "VIDEO" ? <p className="muted small">To make an ending image from this video, choose “Save this frame as photo” under Start, or upload an End photo.</p> : null}
      {card || startOnly ? <ShotKeyframePanel role="start" input={imageInput("start")} recoveryKey={recoveryKey} durableRecovery={card?.recovery} onRecovery={onCardRecovery} selectedAssetId={firstFrame?.assetId} disabled={busy || furnitureBlocked || !draftLoaded || !distanceValid || !sketchValid}
        onAssets={receiveAssets} onBalance={receiveBalance} onBlocked={setStartImageBlocked} onUse={asset => useImage("start", asset)} onKeepSource={input => chooseSource(false, `asset:${input.source.assetId}`)} /> : null}
      {!startOnly ? <ShotKeyframePanel role="end" input={imageInput("end")} recoveryKey={recoveryKey} durableRecovery={card?.recovery} onRecovery={onCardRecovery} selectedAssetId={lastFrame?.assetId} disabled={busy || furnitureBlocked || !draftLoaded || !distanceValid || !sketchValid}
        onAssets={receiveAssets} onBalance={receiveBalance} onBlocked={setEndImageBlocked} onUse={asset => useImage("end", asset)} onKeepSource={input => chooseSource(true, `asset:${input.source.assetId}`)} /> : null}
      {!card && !startOnly ? <details className={styles.details}><summary>Prepare a different Start image</summary>
        <ShotKeyframePanel role="start" input={imageInput("start")} recoveryKey={recoveryKey} selectedAssetId={firstFrame?.assetId} disabled={busy || furnitureBlocked || !draftLoaded || !distanceValid || !sketchValid}
          onAssets={receiveAssets} onBalance={receiveBalance} onBlocked={setStartImageBlocked} onUse={asset => useImage("start", asset)} onKeepSource={input => chooseSource(false, `asset:${input.source.assetId}`)} />
      </details> : null}
      </>}
      {startOnly ? <section className={styles.propertyReview} aria-label="Manual Start property review">
        <h3 className={styles.sectionTitle}>Compare your original and Start</h3>
        <div className={styles.reviewImages}>{([{ label: "Original reference", asset: reviewSource }, { label: "Selected Start", asset: reviewStart }]).map(({ label, asset }) =>
          <figure key={label}><figcaption>{label}</figcaption>{asset ? <img src={asset.url} alt={label}
            onLoad={() => setReviewImagesLoaded(old => ({ ...old, [asset.url]: true }))} onError={() => { setReviewImagesLoaded(old => ({ ...old, [asset.url]: false })); setReviewedStart(undefined); }} /> : <p>Choose a Start photo above.</p>}</figure>
        )}</div>
        <label><input type="checkbox" disabled={busy || !startPreviewsReady || !sketchValid} checked={startReviewed} onChange={event => setReviewedStart(event.target.checked ? startReviewKey : undefined)} /> I compared rooflines, supports, openings, tile grids and furniture. This is my manual review, not a geometry guarantee.</label>
        <p className={styles.hint}>Video quote: {credits} credits for {seconds} seconds. No End image is required. Inspect these anchors throughout the finished video before using it.</p>
      </section> : null}
      </section>
      <details className={`${styles.advanced} ${styles.details}`} hidden={!!card?.request}><summary>More shot options</summary>
      {card && onCardPair && !card.request && !startOnly ? <label className="field">Frame preparation
        <select className="text-input" value={guided ? "guided" : "manual"} disabled={busy} onChange={e => { setWorkflow(e.target.value as "guided" | "manual"); setReviewedPair(undefined); }}>
          <option value="guided">Prepare Start and End together</option><option value="manual">Choose and prepare frames individually</option>
        </select>
      </label> : null}
      {guided || startOnly ? <>
        <label className="field">Lens direction<select className="text-input" value={(cinematography ?? DEFAULT_SHOT_CINEMATOGRAPHY).lensMm} disabled={busy} onChange={e => {
          resetGeneratedFrames(); setCinematography({ ...(cinematography ?? DEFAULT_SHOT_CINEMATOGRAPHY), lensMm: e.target.value === "source" ? "source" : Number(e.target.value) as 24 | 35 | 50 });
        }}><option value="source">Match the reference</option><option value={24}>24 mm · architectural wide</option><option value={35}>35 mm · natural perspective</option><option value={50}>50 mm · detail</option></select></label>
        <label className="field">White balance<select className="text-input" value={(cinematography ?? DEFAULT_SHOT_CINEMATOGRAPHY).whiteBalanceKelvin} disabled={busy} onChange={e => {
          resetGeneratedFrames(); setCinematography({ ...(cinematography ?? DEFAULT_SHOT_CINEMATOGRAPHY), whiteBalanceKelvin: e.target.value === "source" ? "source" : Number(e.target.value) });
        }}><option value="source">Match the reference</option><option value={3200}>3200 K · warm interior</option><option value={4500}>4500 K · neutral interior</option><option value={5600}>5600 K · daylight</option><option value={6500}>6500 K · cool daylight</option></select></label>
        <p className="muted small">Photographic direction for Nano Banana. Veo preserves the prepared frames’ look. Lens and temperature are creative guidance; review the result.</p>
      </> : null}
      {!guided ? <><label className="field">Make a shot
        <select className="text-input" value={mode} disabled={busy} onChange={e => {
          const value = e.target.value as AiShotMode;
          resetGeneratedFrames(); setCameraSketch(undefined); setDirection(null); setMode(value);
          if (["gimbal", "drone"].includes(value) && allPhotos.find(a => a.id === firstFrame?.assetId)?.kind !== "IMAGE") setPhoto("");
        }}>
          {AI_SHOT_MODES.map(m => <option key={m} value={m}>{AI_SHOT_LABELS[m]}</option>)}
        </select>
      </label>
      {isCameraMove(mode) ? <p className="muted small">{AI_CAMERA_MOVE_RECIPES[mode].lens}. On a real shoot: {AI_CAMERA_MOVE_RECIPES[mode].hands} Start from a photo or a frame of the room; Veo makes the move from there.</p> : null}
      {mode === "drone" ? <p className="muted small">Choose an exterior photo with room above the roofline. A small rise is more faithful than a wide invented aerial view.</p> : null}
      {mode === "orbit" ? <p className="muted small">Choose an exterior with space around the building. An ending view from another angle helps guide the orbit; unseen sides are interpreted by AI.</p> : null}
      {mode === "fly-through" ? <p className="muted small">Use a wide view with visible openings. Add a landing frame from the next room to guide the flight.</p> : null}
      {mode === "day-night" ? <p className="muted small">A fixed view works best: daylight, moving shadows, sunset and glowing windows. An optional night reference guides the finish.</p> : null}
      {mode === "construction" ? <p className="muted small">Use before and after views from a similar angle. Creates an AI construction concept between them; the full build stays in the edit, so 8 seconds is recommended.</p> : null}
      {!bridge ? <label className="field">Camera move
        <select className="text-input" value={move} disabled={busy} data-testid="ai-move" onChange={e => {
          const value = e.target.value as MoveId | "";
          resetGeneratedFrames(); setCameraSketch(undefined); setDirection(null); setMove(value); setChosenSeconds(null); requestId.current = null;
          // The move's words become the prompt, to edit; clearing the move puts the usual line back.
          setPrompt(value ? movePrompt(value) : DEFAULT_PROMPT);
        }}>
          <option value="">None · the shot type's own movement</option>
          {MOVE_GROUPS.map(group => <optgroup key={group} label={MOVE_GROUP_LABELS[group]}>
            {MOVES.filter(m => m.group === group).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </optgroup>)}
        </select>
        {move ? <span className="muted small">{moveById(move).ai.lens}. On a real shoot: {moveById(move).ai.hands}{moveById(move).real ? " Also available on footage you already have: tap Motion on a shot." : ""}</span> : null}
      </label> : null}
      <label className="field">Quality
        <select className="text-input" value={draftMode ? "draft" : "final"} disabled={busy} data-testid="ai-quality" onChange={e => { setQuality(e.target.value as "draft" | "final"); requestId.current = null; }}>
          <option value="final">Full take · {aiClipCredits(seconds)} {aiClipCredits(seconds) === 1 ? "credit" : "credits"} · 1080p</option>
          <option value="draft" disabled={Boolean(noDraft)}>Draft preview · {AI_DRAFT_CREDITS} credit · 720p, silent</option>
        </select>
        <span className="muted small">{noDraft ?? (seconds === 8
          ? `A draft shows the move first for ${AI_DRAFT_CREDITS} credit instead of ${aiClipCredits(8)}. Make it final then costs the rest of the full price, so a draft you keep adds nothing.`
          : "A 4-second draft costs the same credit as the full take, so it only saves time. Use drafts on 8-second shots.")}</span>
      </label>
      <label className="field">Cinematic style
        <select className="text-input" value={style} disabled={busy} onChange={e => setStyle(e.target.value as AiShotStyle)}>
          {AI_SHOT_STYLES.map(value => <option key={value} value={value}>{AI_SHOT_STYLE_LABELS[value]}</option>)}
        </select>
      </label>
      <label className="field">Light and weather
        <select className="text-input" value={atmosphere} disabled={busy || mode === "day-night"} onChange={e => setAtmosphere(e.target.value as AiShotAtmosphere)}>
          {AI_SHOT_ATMOSPHERES.map(value => <option key={value} value={value}>{AI_SHOT_ATMOSPHERE_LABELS[value]}</option>)}
        </select>
        {mode === "day-night" ? <span className="muted small">Light progresses from day into night.</span> : null}
      </label>
      <label className="field">Energy
        <select className="text-input" value={energy} disabled={busy} onChange={e => setEnergy(e.target.value as "subtle" | "bold")}>
          <option value="subtle">Controlled and elegant</option><option value="bold">Bold and over the top</option>
        </select>
      </label>
      {!card && onAdd && style !== "source" ? <label className="field"><span><input type="checkbox" checked={harmonize} disabled={busy} onChange={e => setHarmonize(e.target.checked)} /> Carry a matching colour grade through the real footage</span>
        <span className="muted small">Editable in Look. Weather and relighting apply to the AI shot.</span></label> : null}
      {!card && onAdd ? <label className="field"><span><input type="checkbox" checked={polish} disabled={busy} onChange={e => setPolish(e.target.checked)} /> Finish the promo with luxury type and camera accents</span>
        <span className="muted small">Pairs editorial and clean fonts, soft lens edges and one snap zoom. Your words, footage and timing stay editable.</span></label> : null}
      {style === "auto" ? <p className="muted small">Suggested direction: {AI_SHOT_STYLE_LABELS[aiShotStyle({ mode, anchor, style })]}. AI handles lighting, depth and atmosphere within this look.</p> : null}
      <label className="field">Describe the shot
        <textarea className="text-input" rows={4} minLength={10} maxLength={2000} required value={currentPrompt}
          placeholder="A slow, smooth camera push into a bright living room, morning light through the windows. Keep the layout and furniture unchanged."
          disabled={busy} onChange={e => { resetGeneratedFrames(); setCameraSketch(undefined); setDirection(null); setPrompt(e.target.value); requestId.current = null; }} />
      </label>
      {!card && anchor && reelId ? <label className="field"><span><input type="checkbox" checked={draft} disabled={busy} onChange={e => setDraft(e.target.checked)} /> Automatically make a separate promo draft</span>
        <span className="muted small">Completes while you are away. Keeps your original reel, music and captions. Changed boundaries wait for review.</span></label> : null}
      </> : null}
      <p className="muted small">{guided ? "The whole reference informs the prepared portrait images. Review interpreted details and framing before video." : "References use the original frame with a centre crop to portrait. Review joins, especially with zoom, colour effects or letterboxing."}</p>
      </details>
      <footer className={styles.finish} hidden={!!card && (guided && !pairReviewed || !!card.request && !!videoJob?.asset)}>
      <h3 className={styles.sectionTitle}>Video</h3>
      {videoJob || card?.request ? <div className={styles.generationProgress}><ShotGenerationProgress stage={videoJob?.status === "SUCCEEDED" ? "ready" : "video"}
        status={videoJob?.status ?? "CHECKING"} requestedAt={videoJob?.createdAt} lastCheckedAt={lastCheckedAt} connectionError={connectionError}
        queueLabel={videoJob?.queue ? queueLabel(videoJob.queue, at => at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) : null} /></div> : null}
      {!card?.request ? <p className="muted small">New images and videos use credits. Review generated property details before publishing.</p> : null}
      {!card && error ? <p className="error small" role="alert">{error}</p> : null}
      {guided && !pairReviewed ? <p className="muted small">Prepare and select both frames above to unlock video generation.</p> : null}
      <button className="btn btn-block" type="submit" hidden={!!card?.request} disabled={busy || !!card?.request || furnitureBlocked || !stagingMatches || !draftLoaded || !sketchValid || !startReviewed || startOnly && !startPreviewsReady || direction !== null && !distanceValid || guided && !pairReviewed || !guided && (startImageBlocked || !startOnly && endImageBlocked) || !state?.enabled || state.balance.remaining < credits || state.jobs.filter(active).length >= AI_QUEUE_LIMIT || (!firstFrame && direction !== null) || (!!firstFrame && !assetFor(firstFrame)) || (!!lastFrame && !assetFor(lastFrame)) || ((bridge || !startOnly && useEndReference) && !lastFrame) || (mode !== "custom" && !firstFrame)}>
        {busy ? "Starting…" : `${draftMode ? "Draft" : "Generate video ·"} ${seconds}-second clip · ${credits} ${credits === 1 ? "credit" : "credits"}`}
      </button>
      {!card?.request ? <p className="muted small"><Link href="/account">Plans and more credits</Link></p> : null}
      </footer>
      </div>
    </form>
    <div className="ai-video-results" aria-live="polite">
      {card?.request && !videoJob?.asset ? <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void refresh().catch(e => setError(e.message))}>Check saved video request</button> : null}
      {card?.request?.payload && !card.request.jobId && !state?.jobs.some(job => job.requestId === card.request!.id) ? <button type="button" className="btn" disabled={busy} onClick={() => void retrySavedRequest()}>Retry saved video request</button> : null}
      {state?.jobs.filter(job => !card || job.requestId === card.request?.id).map(job => <article className="ai-video-result" key={job.id}>
        <p className="small">{tierOf(job) === "draft" ? "Draft · " : tierOf(job) === "final" && (job.shot as { finalOf?: string }).finalOf ? "Final · " : ""}{aiShotSchema.safeParse(job.shot).success ? `${(job.shot as AiShot).move ? `${moveById((job.shot as AiShot).move!).label} · ` : ""}${AI_SHOT_LABELS[(job.shot as AiShot).mode]} · ${AI_SHOT_STYLE_LABELS[aiShotStyle(job.shot as AiShot)]}` : job.prompt}</p>
        {active(job) ? <p className="muted small" role="status">{job.status === "QUEUED" ? queueLabel(job.queue ?? null, at => at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) : job.status === "SUBMITTING" ? "Preparing your video…" : "Generating your shot…"} You can leave and return later.</p> : null}
        {job.status === "FAILED" || job.status === "UNRESOLVED" ? <p className="error small">{job.error}</p> : null}
        {job.take?.wrongWords ? <p className="error small" role="alert">Wrong words: she said “{job.take.heard || "nothing we could hear"}”, not “{job.take.line}”.</p> : null}
        {job.asset && job.take && !job.take.wrongWords ? <p className="muted small">Trimmed to her line: {(job.take.startMs / 1000).toFixed(2)}–{(job.take.endMs / 1000).toFixed(2)} s{job.faceHeightPx ? ` · face ${job.faceHeightPx} px (${job.framing ?? "medium"})` : ""}</p> : null}
        {job.asset ? <>
          <video src={job.asset.url} controls playsInline preload="metadata" aria-label="Generated AI clip" />
          <p className="muted small">{card ? "Review your AI shot before using it." : "AI-generated · saved in your media library"}{tierOf(job) === "draft" ? " · 720p preview, silent" : ""}</p>
          {!card && tierOf(job) === "draft" && !job.finalId && job.durationSeconds ? <button type="button" className="btn btn-block" data-testid="make-final" disabled={busy || !state?.enabled}
            onClick={() => makeFinal(job)}>Make it final · {finalCredits(job)} {finalCredits(job) === 1 ? "credit" : "credits"}</button> : null}
          {tierOf(job) === "draft" && job.finalId ? <p className="muted small">Made final.</p> : null}
          {job.draftId ? <Link className="btn btn-block" href={`/reels/${job.draftId}`}>Review blended promo draft</Link> : null}
          {job.asset && (job.shot as AiShot | null)?.draftReelId && !job.draftId ? <p className="muted small">The source boundary changed. Your clip is ready in the media library.</p> : null}
          {onAdd ? <button type="button" className="btn btn-block" onClick={() => { const recipe = aiShotSchema.safeParse(job.shot); onAdd(job.asset!, recipe.success ? recipe.data : undefined, job.id, job.durationSeconds); }}>{card ? "Use shot" : (job.shot as AiShot | null)?.anchor ? "Place at source cut / replace still" : "Add to reel"}</button> :
            <Link className="btn btn-quiet btn-block" href="/">Open your reels to use this clip</Link>}
        </> : null}
      </article>)}
    </div>
  </div>;
}
