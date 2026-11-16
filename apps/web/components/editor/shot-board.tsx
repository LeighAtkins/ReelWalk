"use client";
import { useRef, useState } from "react";
import { insertShotCard, moveShotCard, removeShotCard, shotCards, updateShotCard, type Timeline } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { uploadFile } from "./upload";
import styles from "./shot-board.module.css";

export function ShotBoard({ timeline, library, onChange, onPrepare, onAsset, onUseTake }: {
  timeline: Timeline; library: Record<string, LibraryAsset>;
  onChange(update: (current: Timeline) => Timeline): void;
  onPrepare(id: string): void;
  onAsset(asset: LibraryAsset): void;
  onUseTake?(id: string, asset: LibraryAsset): void;
}) {
  const cards = shotCards(timeline), [menu, setMenu] = useState<string>(), [error, setError] = useState("");
  const [uploading, setUploading] = useState<string>();
  const lock = useRef(false);
  const add = (before?: string) => onChange(current => insertShotCard(current, crypto.randomUUID(), before));
  async function upload(id: string, file?: File) {
    if (!file || lock.current) return;
    if (!/\.(jpe?g|png)$/i.test(file.name) || file.type && !["image/jpeg", "image/png"].includes(file.type) || file.size > 20 * 1024 * 1024) { setError("Choose a JPEG or PNG under 20 MB."); return; }
    lock.current = true; setUploading(id); setError("");
    try {
      const asset = await uploadFile(file, () => {});
      if (asset.kind !== "IMAGE" || asset.isPano) throw Error("Choose a regular photo.");
      onAsset(asset);
      // The upload endpoint retains the media even if this card was removed meanwhile.
      onChange(current => updateShotCard(current, id, card => ({ id: card.id, sourceAssetId: asset.id })));

    } catch (e) { setError(e instanceof Error ? e.message : "Upload failed. Your card is unchanged."); }
    finally { lock.current = false; setUploading(undefined); }
  }
  return <section className={styles.board} aria-label="Shot board" onKeyDown={event => { if (event.key === "Escape") setMenu(undefined); }}>
    <header><h2>Build your sequence</h2><p>Add a photo and review its frames. Only completed shots play and export.</p></header>
    <div className={styles.sequence}>
      {cards.map((card, index) => {
        const clip = timeline.clips.find(item => item.id === card.clipId), asset = library[clip?.assetId ?? card.sourceAssetId ?? ""];
        return <div className={styles.slot} key={card.id}>
          <button type="button" className={styles.insert} aria-label={`Insert shot before ${index + 1}`} title={`Insert shot before ${index + 1}`} onClick={() => add(card.id)}>+</button>
          <article className={styles.card} onContextMenu={event => { event.preventDefault(); event.currentTarget.querySelector<HTMLButtonElement>("button[aria-expanded]")?.focus({ preventScroll: true }); setMenu(card.id); }}
            onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!clip) void upload(card.id, event.dataTransfer.files[0]); }}>
            <h3>Shot {index + 1} - {clip ? "Ready" : card.sourceAssetId ? "Prepare frames" : "Empty"}</h3>
            {asset ? clip?.kind === "VIDEO" ? <video src={asset.url} poster={asset.thumbUrl ?? undefined} controls playsInline preload="metadata" aria-label={`Shot ${index + 1} video`} /> : <img src={asset.url} alt={`Shot ${index + 1} source`} /> : <div className={styles.empty}>Drop your property photo here</div>}
            {!clip ? <><label className={styles.upload}>Upload / replace photo<input type="file" accept="image/jpeg,image/png" disabled={!!uploading} onChange={event => { void upload(card.id, event.target.files?.[0]); event.target.value = ""; }} /></label>
              <button type="button" disabled={uploading === card.id} onClick={() => onPrepare(card.id)}>Prepare Start / End, then Video</button>
              </> : null}
            {uploading === card.id ? <p role="status">Uploading photo...</p> : null}
            {card.request && !clip ? <p role="status">Saved video request. Open Prepare to check status; no automatic submission.</p> : null}
            <button type="button" aria-expanded={menu === card.id} onClick={() => setMenu(menu === card.id ? undefined : card.id)}>Shot actions ...</button>
            {menu === card.id ? <div className={styles.actions}>
              <button type="button" onClick={() => setMenu(undefined)}>Close shot actions</button>
              {!clip && onUseTake && Object.values(library).some(asset => asset.kind === "VIDEO") ? <label className={styles.upload}>Choose a saved video<select aria-label={`Saved video for shot ${index + 1}`} disabled={uploading === card.id} value="" onChange={event => { const asset = library[event.target.value]; if (asset?.kind === "VIDEO") onUseTake(card.id, asset); }}>
                <option value="">Choose from Media</option>{Object.values(library).filter(asset => asset.kind === "VIDEO").map(asset => <option key={asset.id} value={asset.id}>{asset.fileName}</option>)}
              </select></label> : null}
              <button type="button" onClick={() => add(card.id)}>Insert before</button>
              <button type="button" onClick={() => add(cards[index + 1]?.id)}>Insert after</button>
              <button type="button" disabled={index === 0} onClick={() => onChange(current => moveShotCard(current, card.id, -1))}>Move earlier</button>
              <button type="button" disabled={index === cards.length - 1} onClick={() => onChange(current => moveShotCard(current, card.id, 1))}>Move later</button>
              <button type="button" onClick={() => onChange(current => removeShotCard(current, card.id))}>Remove shot</button>
            </div> : null}
          </article></div>;
      })}
      <button type="button" className={styles.insert} onClick={() => add()}>+ Add shot</button>
    </div>
    {error ? <p role="status">{error}</p> : null}
  </section>;
}
