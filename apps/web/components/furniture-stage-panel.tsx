"use client";
import { useEffect, useRef, useState } from "react";
import { FURNITURE_STYLES, furnitureStageSchema, type CameraKeyframeJob, type CameraKeyframeInput, type FurnitureStage } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { furnitureConceptInput, furnitureRegion } from "./furniture-stage";
import { ShotKeyframePanel } from "./shot-keyframe-panel";
import styles from "./shot-workspace.module.css";

export function FurnitureStagePanel({ photos, source, stage, disabled, recoveryKey, durableRecovery, onRecovery, selectedAssetId, onSource, onChange, onUse, onOriginal, onAssets, onBalance, onBlocked, derivativeHash }: {
  derivativeHash?: string;
  photos: LibraryAsset[]; source: string; stage: FurnitureStage; disabled: boolean; recoveryKey: string;
  durableRecovery?: Record<string, string>; onRecovery?(key: string, value: string): Promise<boolean>; selectedAssetId?: string;
  onSource(value: string): void; onChange(value: FurnitureStage): void; onUse(asset: LibraryAsset, input: CameraKeyframeInput, derivativeHash?: string): void; onOriginal(input: CameraKeyframeInput): void;
  onAssets(assets: LibraryAsset[]): void; onBalance(value: number): void; onBlocked(value: boolean): void;
}) {
  const frame = useRef<HTMLDivElement>(null), origin = useRef<{ x: number; y: number } | null>(null);
  const [loadedSource, setLoadedSource] = useState<string>(), [regionError, setRegionError] = useState("");
  const asset = photos.find(asset => `asset:${asset.id}` === source && asset.kind === "IMAGE" && !asset.isPano);
  const input = asset ? furnitureConceptInput(asset.id, stage) : null;
  const selectedProvenance = photos.find(item => item.id === selectedAssetId)?.aiKeyframe;
  const derivativeJobId = selectedProvenance?.outputHash === derivativeHash && selectedProvenance?.sourceAssetId === asset?.id ? selectedProvenance?.jobId : undefined;
  const region = stage.region;
  const [adjusting, setAdjusting] = useState<CameraKeyframeJob<LibraryAsset>>();
  const [preview, setPreview] = useState<{ url: string; hash: string; identity: string }>();
  const [adjustBusy, setAdjustBusy] = useState(false);
  const scope = JSON.stringify([recoveryKey, source]);
  const mounted = useRef(true);
  const [readyPreview, setReadyPreview] = useState<string>();
  const identity = JSON.stringify([recoveryKey, adjusting?.id, source, stage]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => { setAdjusting(undefined); setPreview(undefined); setReadyPreview(undefined); setAdjustBusy(false); setRegionError(""); }, [scope]);
  const latestIdentity = useRef(identity);
  const generation = useRef(0);
  if (latestIdentity.current !== identity) { generation.current++; latestIdentity.current = identity; }
  useEffect(() => { setAdjustBusy(false); setReadyPreview(undefined); }, [identity]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  async function adjustment(save: boolean) {
    if (!adjusting || adjustBusy || source !== `asset:${adjusting.input.source.assetId}` || (save && (!preview || readyPreview !== preview.url || preview.identity !== identity))) return;
    const captured = identity, capturedGeneration = generation.current;
    setAdjustBusy(true); setRegionError(""); if (!save) { setPreview(undefined); setReadyPreview(undefined); }
    try {
      const response = await fetch("/api/ai/keyframes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: save ? "save-furniture-area" : "preview-furniture-area", jobId: adjusting.id, region, ...(save ? { previewHash: preview?.hash } : {}) }) });
      if (!response.ok) throw Error((await response.json()).error || "Adjustment unavailable.");
      if (save) {
        const result = await response.json();
        if (!mounted.current || latestIdentity.current !== captured || generation.current !== capturedGeneration) return;
        onAssets([result.asset]); onChange(result.input.furnitureStage); onUse(result.asset, result.input, result.lineage.hash); setAdjusting(undefined); setPreview(undefined);
      } else {
        const blob = await response.blob();
        if (!mounted.current || latestIdentity.current !== captured || generation.current !== capturedGeneration) return;
        setPreview({ url: URL.createObjectURL(blob), hash: response.headers.get("X-Preview-Hash")!, identity: captured });
      }
    } catch (error) { if (!mounted.current || latestIdentity.current !== captured || generation.current !== capturedGeneration) return; setRegionError(error instanceof Error ? error.message : "Adjustment unavailable."); }
    finally { if (mounted.current && latestIdentity.current === captured && generation.current === capturedGeneration) setAdjustBusy(false); }
  }
  function point(event: React.PointerEvent) {
    const box = frame.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) };
  }
  function adjust(key: keyof typeof region, value: number) {
    const next = { ...region, [key]: value };
    if (key === "x") next.width = Math.min(next.width, 1 - value);
    if (key === "y") next.height = Math.min(next.height, 1 - value);
    if (key === "width") next.width = Math.min(value, 1 - next.x);
    if (key === "height") next.height = Math.min(value, 1 - next.y);
    const parsed = furnitureStageSchema.safeParse({ ...stage, region: next });
    if (parsed.success) { onChange(parsed.data); setRegionError(""); }
  }
  return <section className={styles.propertyReview} aria-label="Furniture concept studio">
    <h3 className={styles.sectionTitle}>Furnish a selected area</h3>
    <label className="field">Original photo<select className="text-input" disabled={disabled} value={source} onChange={event => onSource(event.target.value)}>
      <option value="">Choose an original photo</option>{photos.filter(asset => asset.kind === "IMAGE" && !asset.isPano).map(asset => <option key={asset.id} value={`asset:${asset.id}`}>{asset.fileName}</option>)}
    </select></label>
    <p className={styles.hint}>Draw a rectangle over movable furniture and its shadows. This preview uses the same centred 9:16 crop as the edit. Pixels outside the area are restored from the original; fixed architecture inside still needs your review. The result is an AI furniture concept, not a photograph of the current property.</p>
    {asset ? <div ref={frame} className={styles.furnitureCanvas} aria-label="Draw furnishing area on portrait reference" onPointerDown={event => {
      if (disabled || event.button !== 0 || loadedSource !== asset.url) return;
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); origin.current = point(event); setRegionError("");
    }} onPointerMove={event => { if (!origin.current || disabled) return; const next = furnitureRegion(origin.current, point(event)); if (next) onChange({ ...stage, region: next }); }} onPointerUp={event => {
      if (!origin.current) return; const next = furnitureRegion(origin.current, point(event)); origin.current = null;
      if (next) onChange({ ...stage, region: next }); else setRegionError("Draw an area at least 2% wide and high, or use the sliders.");
    }} onPointerCancel={() => { origin.current = null; }}>
      <img src={asset.url} alt="Original photo, centred portrait crop for furniture editing" draggable={false} onLoad={() => setLoadedSource(asset.url)} onError={() => setLoadedSource(undefined)} />
      <div className={styles.furnitureRegion} style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}><span>Furnishing area</span></div>
    </div> : null}
    <fieldset disabled={disabled}><legend>Area position and size · keyboard controls</legend>{(["x", "y", "width", "height"] as const).map(key => <label key={key} className="field">{({ x: "Left", y: "Top", width: "Width", height: "Height" })[key]} · {Math.round(region[key] * 100)}%
      <input type="range" min={key === "x" || key === "y" ? 0 : 2} max={key === "x" || key === "y" ? 98 : 100} step={1} value={Math.round(region[key] * 100)} onChange={event => adjust(key, Number(event.target.value) / 100)} />
    </label>)}</fieldset>
    {adjusting ? <div>
      <p>Adjust the area using the saved result. No generation or credits. Review furniture and architectural seams before use.</p>
      <fieldset disabled={disabled || adjustBusy}><legend>Exact portrait pixels (1080 ? 1920)</legend>{(["x", "y", "width", "height"] as const).map(key => <label key={key}>{key}<input type="number" step="1" value={Math.round(region[key] * (key === "x" || key === "width" ? 1080 : 1920))} onChange={event => adjust(key, Number(event.target.value) / (key === "x" || key === "width" ? 1080 : 1920))} /></label>)}</fieldset>
      <img src={adjusting.sourceUrl!} alt="Immutable source" width={180} /><img src={adjusting.candidateUrl!} alt="Original saved concept" width={180} />
      {preview?.identity === identity ? <img key={preview.url} src={preview.url} alt="Adjusted concept preview" width={180} onLoad={() => { if (mounted.current && latestIdentity.current === preview.identity) setReadyPreview(preview.url); }} onError={() => setReadyPreview(undefined)} /> : null}
      <button type="button" disabled={disabled || adjustBusy} onClick={() => void adjustment(false)}>Preview adjusted area</button>
      <button type="button" disabled={disabled || adjustBusy || preview?.identity !== identity || readyPreview !== preview?.url} onClick={() => void adjustment(true)}>Use adjusted concept</button>
      <button type="button" disabled={adjustBusy} onClick={() => { setAdjusting(undefined); setPreview(undefined); }}>Cancel adjustment</button>
    </div> : null}
    {regionError ? <p role="alert">{regionError}</p> : null}
    <label className="field">Furniture style<select className="text-input" disabled={disabled} value={stage.style} onChange={event => onChange({ ...stage, style: event.target.value as FurnitureStage["style"] })}>{FURNITURE_STYLES.map(style => <option key={style.id} value={style.id}>{style.label}</option>)}</select></label>
    <label className="field">Furniture preferences<textarea className="text-input" maxLength={300} rows={3} disabled={disabled} value={stage.instructions} onChange={event => onChange({ ...stage, instructions: event.target.value })} placeholder="For example: a cream sofa, low oak table, and space to walk." /></label>
    <p className={styles.hint}>One concept image · 1 credit. No End pair or video is generated by this step. Keep your camera direction for the next step.</p>
    <ShotKeyframePanel role="end" variant="furniture" input={input} recoveryKey={`${recoveryKey}:furniture`} durableRecovery={durableRecovery} onRecovery={onRecovery} selectedAssetId={selectedAssetId} selectedDerivative={!!derivativeHash && !!selectedAssetId} selectedDerivativeJobId={derivativeJobId} disabled={disabled || !asset || loadedSource !== asset.url}
      onAdjust={job => { if (source !== `asset:${job.input.source.assetId}`) return; setReadyPreview(undefined); setAdjusting(job); setPreview(undefined); onChange(job.id === derivativeJobId ? { ...job.input.furnitureStage!, region: stage.region } : job.input.furnitureStage!); }} onUse={onUse} onKeepSource={onOriginal} onAssets={onAssets} onBalance={onBalance} onBlocked={onBlocked} />
  </section>;
}
