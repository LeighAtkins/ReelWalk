"use client";

import { useEffect, useState } from "react";
import { PORTRAIT_FACE_MIN_PX } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import type { PublicPresenter } from "@/lib/presenters";
import { uploadFile } from "./upload";

/** Photos the studio uploaded itself: a kit never uses the starter library or a generated take (ADR 0056). */
const ownedStill = (asset: LibraryAsset) => asset.kind === "IMAGE" && !asset.isPano && !asset.credit && !asset.isAiGenerated && !asset.id.startsWith("ai-");

/**
 * The presenter picker in Ask Opus, and a small "Set up presenter" flow:
 * a portrait and a full-length photo, uploaded here or chosen from the
 * library. Every composed AI shot uses the picked kit for her face.
 */
export function PresenterPicker({ library, value, onChange, onAssets, disabled }: {
  library: LibraryAsset[]; value: string | null; onChange(id: string | null): void;
  onAssets?(assets: LibraryAsset[]): void; disabled?: boolean;
}) {
  const [kits, setKits] = useState<PublicPresenter[] | null>(null);
  const [setup, setSetup] = useState(false);
  const [message, setMessage] = useState("");
  async function reload() {
    const response = await fetch("/api/presenters", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json() as { presenters: PublicPresenter[] };
    setKits(data.presenters);
    if (!value || !data.presenters.some(kit => kit.id === value)) onChange(data.presenters.find(kit => kit.isDefault)?.id ?? null);
  }
  useEffect(() => { void reload(); }, []);
  async function retry(id: string) {
    const response = await fetch(`/api/presenters/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ retry: true }) });
    const data = await response.json().catch(() => ({}));
    setMessage(response.ok ? "Trying her face reference again…" : data.error ?? "Could not retry.");
    await reload();
  }
  // The worker cuts her face crop in a few seconds; look again while one is being prepared.
  const preparing = kits?.some(kit => !kit.ready && kit.status.startsWith("Preparing"));
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(() => { void reload(); }, 8000);
    return () => clearInterval(timer);
  }, [preparing]);
  const chosen = kits?.find(kit => kit.id === value) ?? null;
  return <fieldset className="field" disabled={disabled} aria-label="Presenter">
    <legend className="small">Presenter</legend>
    {kits === null ? <span className="muted small">Loading presenters…</span> : kits.length === 0
      ? <span className="muted small">No presenter yet. Set one up so every AI shot keeps her face: shots made from earlier AI takes drift into a different person.</span>
      : <label className="small">Her face comes from <select value={value ?? ""} onChange={e => onChange(e.target.value || null)}>
          {kits.map(kit => <option key={kit.id} value={kit.id}>{kit.name}{kit.isDefault ? " (default)" : ""}</option>)}
        </select></label>}
    {chosen ? <span className={`small ${chosen.ready ? "muted" : ""}`}>{chosen.status}</span> : null}
    {chosen?.canRetry ? <button type="button" className="btn btn-quiet btn-block" onClick={() => { void retry(chosen.id); }}>Retry her face reference</button> : null}
    <button type="button" className="btn btn-quiet btn-block" onClick={() => setSetup(open => !open)}>{setup ? "Close presenter setup" : "Set up presenter"}</button>
    {setup ? <PresenterSetup library={library} onAssets={onAssets} onDone={async (kit) => { setSetup(false); setMessage(`${kit.name} is set up. Her face reference is being prepared.`); await reload(); onChange(kit.id); }} /> : null}
    {message ? <p role="status" className="small">{message}</p> : null}
  </fieldset>;
}

function PresenterSetup({ library, onAssets, onDone }: { library: LibraryAsset[]; onAssets?(assets: LibraryAsset[]): void; onDone(kit: PublicPresenter): Promise<void> }) {
  const [name, setName] = useState("");
  const [portrait, setPortrait] = useState(""), [fullBody, setFullBody] = useState("");
  const [uploaded, setUploaded] = useState<LibraryAsset[]>([]);
  const [makeDefault, setMakeDefault] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const stills = [...new Map([...uploaded, ...library].filter(ownedStill).map(asset => [asset.id, asset])).values()];
  async function upload(file: File | undefined, pick: (id: string) => void) {
    if (!file) return;
    setBusy(true); setError("");
    try {
      const asset = await uploadFile(file, () => undefined);
      setUploaded(current => [...current, asset]); onAssets?.([asset]); pick(asset.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "That photo could not be uploaded."); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/presenters", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, portraitAssetId: portrait, fullBodyAssetId: fullBody, isDefault: makeDefault }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "The presenter could not be saved.");
      await onDone(data.presenter);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The presenter could not be saved."); }
    finally { setBusy(false); }
  }
  const chooser = (label: string, hint: string, value: string, set: (id: string) => void, id: string) => <label className="field small">{label}
    <span className="muted">{hint}</span>
    <select value={value} onChange={e => set(e.target.value)} disabled={busy}>
      <option value="">Choose a photo you uploaded…</option>
      {stills.map(asset => <option key={asset.id} value={asset.id}>{asset.fileName}{asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ""}</option>)}
    </select>
    <input id={id} data-presenter-upload={id} type="file" accept="image/jpeg,image/png" disabled={busy} onChange={e => { void upload(e.target.files?.[0], set); e.target.value = ""; }} />
  </label>;
  return <section aria-label="Set up presenter">
    <label className="field small">Name<input className="text-input" maxLength={60} value={name} onChange={e => setName(e.target.value)} disabled={busy} placeholder="Maya" /></label>
    {chooser("Portrait", `Head and shoulders, facing the camera, her face ${PORTRAIT_FACE_MIN_PX} px tall or more.`, portrait, setPortrait, "presenter-portrait")}
    {chooser("Full-length photo", "Head to feet, clean background, the outfit she wears in the reel.", fullBody, setFullBody, "presenter-full-body")}
    <label className="small"><input type="checkbox" checked={makeDefault} onChange={e => setMakeDefault(e.target.checked)} disabled={busy} /> Use her for every AI shot by default</label>
    <button type="button" className="btn btn-signal btn-block" disabled={busy || !name.trim() || !portrait || !fullBody} onClick={() => { void save(); }}>{busy ? "Saving…" : "Save presenter"}</button>
    {error ? <p role="alert" className="small">{error}</p> : null}
  </section>;
}
