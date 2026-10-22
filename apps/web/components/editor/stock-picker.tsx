"use client";

import { useState } from "react";
import type { StockGroup } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";

/**
 * The Stock tab of Add media (ADR 0070). A search answers with sets: clips
 * from one creator and one place, portrait, with no people and no burnt-in
 * text, so one tap adds footage that cuts together. Clips go through
 * `/api/stock/import`, which keeps each one's source, licence and credit on
 * the asset; the export page lists them under Sources.
 */
type SearchState =
  | { phase: "idle" }
  | { phase: "searching" }
  | { phase: "results"; groups: StockGroup[]; checked: number; total: number }
  | { phase: "error"; message: string };

type SearchResponse = { ok: true; groups: StockGroup[] | null; clips?: StockGroup["clips"]; checked: number; total: number } | { ok: false; error: string; unconfigured?: boolean };
type ImportResponse = { ok: true; assets: LibraryAsset[]; failed: { id: number; error: string }[] } | { ok: false; error: string };

const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))} s`;

export function StockPicker({ onAdd }: { onAdd(assets: LibraryAsset[]): void }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ phase: "idle" });
  const [picked, setPicked] = useState<string[]>([]);
  const [importing, setImporting] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setState({ phase: "searching" });
    setPicked([]);
    setNote(null);
    try {
      const response = await fetch(`/api/stock/search?q=${encodeURIComponent(q)}&group=creator`, { credentials: "same-origin" });
      const data = (await response.json()) as SearchResponse;
      if (!data.ok) {
        setState({ phase: "error", message: data.unconfigured ? "Stock search is not set up on this deployment." : data.error });
        return;
      }
      setState({ phase: "results", groups: data.groups ?? [], checked: data.checked, total: data.total });
    } catch {
      setState({ phase: "error", message: "The search did not answer. Try again." });
    }
  };

  const add = async (ids: string[], label: string) => {
    if (ids.length === 0 || importing) return;
    setImporting(label);
    setNote(null);
    try {
      const response = await fetch("/api/stock/import", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: ids.map(Number) }),
      });
      const data = (await response.json()) as ImportResponse;
      if (!data.ok) {
        setNote(data.error);
        return;
      }
      if (data.failed.length > 0) setNote(`${data.failed.length} of ${ids.length} could not be imported: ${data.failed[0].error}`);
      if (data.assets.length > 0) onAdd(data.assets);
    } catch {
      setNote("The import did not finish. Try again.");
    } finally {
      setImporting(null);
    }
  };

  const toggle = (key: string) => setPicked((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));

  return (
    <div className="stock-picker" data-testid="stock-picker">
      <form
        className="stock-search"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="villa pool, white kitchen, lake cabin…" aria-label="Search stock footage" enterKeyHint="search" />
        <button type="submit" className="btn" disabled={state.phase === "searching" || !query.trim()}>
          Search
        </button>
      </form>
      <p className="muted small">Portrait clips with no people and no watermark, in sets from one creator and one place, so they cut together. Free to use; where each came from is kept with the clip.</p>
      {state.phase === "searching" ? <p className="muted small" role="status">Searching, and checking frames for people and text…</p> : null}
      {state.phase === "error" ? (
        <p className="small" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.phase === "results" && state.groups.length === 0 ? <p className="muted small">Nothing portrait without people for that. Try another word for the place.</p> : null}
      {note ? (
        <p className="small" role="alert">
          {note}
        </p>
      ) : null}
      {state.phase === "results"
        ? state.groups.map((group) => (
            <div className="stock-group" key={group.key} data-testid="stock-group">
              <div className="stock-group-head">
                <strong>{group.label}</strong>
                <span className="muted small">
                  {group.creator} · {group.clips.length === 1 ? "1 clip" : `${group.clips.length} clips`}
                </span>
              </div>
              <div className="stock-strip">
                {group.clips.map((clip) => {
                  const key = `${clip.source}:${clip.id}`;
                  const order = picked.indexOf(key);
                  return (
                    <button key={key} type="button" className="library-item" aria-pressed={order >= 0} aria-label={`${group.creator} clip ${clip.id}`} title={clip.tags.slice(0, 5).join(", ")} onClick={() => toggle(key)}>
                      <img src={clip.poster} alt="" loading="lazy" />
                      <span className="chip timecode">{order >= 0 ? order + 1 : seconds(clip.durationMs)}</span>
                      {clip.checks && clip.checks.framesChecked > 0 ? null : (
                        <span className="chip" style={{ left: 4, right: "auto", top: 4, bottom: "auto" }} title="Frames were not checked; the tags say no people or text.">
                          unchecked
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <button type="button" className="btn btn-quiet btn-block" disabled={importing !== null} onClick={() => void add(group.clips.map((clip) => clip.id), group.key)}>
                {importing === group.key ? "Importing the set…" : `Add the set (${group.clips.length})`}
              </button>
            </div>
          ))
        : null}
      {picked.length > 0 ? (
        <button type="button" className="btn btn-block sheet-sticky" disabled={importing !== null} onClick={() => void add(picked.map((key) => key.split(":")[1]), "picked")}>
          {importing === "picked" ? "Importing…" : `Add ${picked.length} to the reel`}
        </button>
      ) : null}
    </div>
  );
}
