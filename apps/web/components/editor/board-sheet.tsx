"use client";

import { useState } from "react";
import {
  BOARD_MAX_COLUMNS,
  BOARD_MAX_ROWS,
  boardColumnStarts,
  EFFECT_FAMILIES,
  EFFECT_FAMILY_LABELS,
  timelineDurationMs,
  type Board,
  type BoardInput,
  type BoardKeywordEffect,
  type BoardPanel,
  type EffectFamily,
  type Timeline,
} from "@reelwalk/core";
import { TEXT_ANIMATION_LABELS } from "@reelwalk/render/reel";
import type { LibraryAsset } from "@/lib/library";
import { Sheet } from "../sheet";

/**
 * The board (ADR 0106) in the editor: add one, set its grid and timing, and for every panel its footage, label, words
 * and effect. Every change is one `setBoard` command, so it undoes in one step and the export draws what the preview
 * shows.
 */

const seconds = (ms: number) => Math.round(ms / 100) / 10;
const toMs = (value: string) => Math.max(0, Math.round(Number(value) * 1000));

/** A first board from the reel's own footage: a 2 × 2 over the whole reel, each panel a clip of it, ready to be titled. */
export function starterBoard(timeline: Timeline, library: Record<string, LibraryAsset>): BoardInput | null {
  const footage = timeline.clips.filter((clip) => library[clip.assetId]?.kind === "VIDEO" || library[clip.assetId]?.kind === "IMAGE");
  if (footage.length === 0) return null;
  const total = timelineDurationMs(timeline);
  return {
    startMs: 0,
    endMs: total,
    rows: 2,
    columns: 2,
    panels: Array.from({ length: 4 }, (_, i) => {
      const clip = footage[i % footage.length];
      return { id: `panel-${i + 1}`, label: `Look ${i + 1}`, assetId: clip.assetId, sourceStartMs: clip.sourceStartMs, mirror: i >= 2, title: { lead: "try this", keyword: `look ${i + 1}`, effect: "dotHop" as const, side: i < 2 ? ("left" as const) : ("right" as const) } };
    }),
  };
}

export function BoardSheet({ timeline, library, onChange, onClose }: {
  timeline: Timeline;
  library: Record<string, LibraryAsset>;
  /** Sends `setBoard`: the whole board, or null to take it off. Returns the refusal, if any. */
  onChange(board: BoardInput | null): string | null;
  onClose(): void;
}) {
  const [error, setError] = useState<string | null>(null);
  const board = timeline.board;
  const footage = Object.values(library).filter((asset) => (asset.kind === "VIDEO" || asset.kind === "IMAGE") && !asset.isPano);
  const send = (next: BoardInput | null) => setError(onChange(next));
  const update = (patch: Partial<Board>) => board && send({ ...board, ...patch });
  const updatePanel = (index: number, patch: Partial<BoardPanel>) => board && send({ ...board, panels: board.panels.map((panel, i) => (i === index ? { ...panel, ...patch } : panel)) });

  if (!board) {
    const starter = starterBoard(timeline, library);
    return (
      <Sheet title="Board" onClose={onClose}>
        <p className="muted small">A board shows several looks side by side: small panels of your footage on a plain background, a column at a time, each with its own label and title. The opening shot shrinks into the first panel.</p>
        <button type="button" className="btn btn-block" disabled={!starter} data-testid="board-add" onClick={() => starter && send(starter)}>Add a board</button>
        {error ? <p className="error small">{error}</p> : null}
      </Sheet>
    );
  }

  const starts = boardColumnStarts(board);
  return (
    <Sheet title="Board" onClose={onClose}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <label className="field">Starts (s)
          <input className="text-input" type="number" step="0.1" min="0" value={seconds(board.startMs)} data-testid="board-start" onChange={(event) => update({ startMs: toMs(event.target.value) })} />
        </label>
        <label className="field">Ends (s)
          <input className="text-input" type="number" step="0.1" min="0" value={seconds(board.endMs)} data-testid="board-end" onChange={(event) => update({ endMs: toMs(event.target.value) })} />
        </label>
        <label className="field">Rows
          <select className="text-input" value={board.rows} onChange={(event) => update({ rows: Number(event.target.value), panels: board.panels.slice(0, Number(event.target.value) * board.columns) })}>
            {Array.from({ length: BOARD_MAX_ROWS }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="field">Columns
          <select className="text-input" value={board.columns} onChange={(event) => {
            const columns = Number(event.target.value);
            // New column times in equal shares: the old ones would no longer fit the count.
            const rest = { ...board, columns, panels: board.panels.slice(0, board.rows * columns) };
            delete rest.columnAtMs;
            send(rest);
          }}>
            {Array.from({ length: BOARD_MAX_COLUMNS }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <label className="field">Shade behind the words (%)
        <input className="text-input" type="number" min="0" max="90" step="5" value={Math.round(board.textShade * 100)} onChange={(event) => update({ textShade: Math.max(0, Math.min(0.9, Number(event.target.value) / 100)) })} />
      </label>
      {board.columns > 1 ? (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {starts.slice(1).map((at, i) => (
            <label key={i} className="field">Column {i + 2} at (s)
              <input className="text-input" type="number" step="0.05" min="0" value={seconds(at)} onChange={(event) => {
                const next = [...starts.slice(1)];
                next[i] = toMs(event.target.value);
                update({ columnAtMs: next });
              }} />
            </label>
          ))}
        </div>
      ) : null}

      {Array.from({ length: board.columns }, (_, column) => (
        <fieldset key={column} className="stack" style={{ gap: 6, border: "none", padding: 0 }}>
          <legend className="small muted">Column {column + 1}</legend>
          {Array.from({ length: board.rows }, (_, row) => {
            const index = column * board.rows + row;
            const panel = board.panels[index];
            if (!panel) {
              return index === board.panels.length ? (
                <button key={row} type="button" className="btn btn-quiet btn-block" onClick={() => send({ ...board, panels: [...board.panels, { ...board.panels[board.panels.length - 1], id: `panel-${Date.now().toString(36)}`, label: "" }] })}>Add a panel</button>
              ) : null;
            }
            const title = panel.title ?? { lead: "", keyword: panel.label || "word", effect: "none" as BoardKeywordEffect, side: "left" as const, delayMs: 0 };
            return (
              <div key={panel.id} className="card stack" style={{ padding: 10, gap: 6 }} data-testid="board-panel">
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <label className="field" style={{ flex: 1 }}>Label
                    <input className="text-input" maxLength={40} value={panel.label} onChange={(event) => updatePanel(index, { label: event.target.value })} />
                  </label>
                  <label className="field" style={{ flex: 1 }}>Footage
                    <select className="text-input" value={panel.assetId} onChange={(event) => updatePanel(index, { assetId: event.target.value })}>
                      {footage.map((asset) => <option key={asset.id} value={asset.id}>{asset.fileName.replace(/\.[a-z0-9]+$/i, "").slice(0, 40)}</option>)}
                    </select>
                  </label>
                </div>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <label className="field" style={{ flex: 1 }}>Lead
                    <textarea className="text-input" rows={2} maxLength={40} value={title.lead} onChange={(event) => updatePanel(index, { title: { ...title, lead: event.target.value } })} />
                  </label>
                  <label className="field" style={{ flex: 1 }}>Keyword
                    <input className="text-input" maxLength={40} value={title.keyword} data-testid="board-keyword" onChange={(event) => event.target.value.trim() && updatePanel(index, { title: { ...title, keyword: event.target.value } })} />
                  </label>
                </div>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <label className="field">Framing
                    <select className="text-input" value={panel.fit} onChange={(event) => updatePanel(index, { fit: event.target.value as "cover" | "contain" })}>
                      <option value="cover">Fill and crop</option>
                      <option value="contain">Fit whole shot</option>
                    </select>
                  </label>
                  <label className="field">Across (%)
                    <input className="text-input" type="number" min="0" max="100" value={Math.round(panel.focusX * 100)} onChange={(event) => updatePanel(index, { focusX: Math.max(0, Math.min(1, Number(event.target.value) / 100)) })} />
                  </label>
                  <label className="field">Down (%)
                    <input className="text-input" type="number" min="0" max="100" value={Math.round(panel.focusY * 100)} onChange={(event) => updatePanel(index, { focusY: Math.max(0, Math.min(1, Number(event.target.value) / 100)) })} />
                  </label>
                  <label className="field">Zoom
                    <input className="text-input" type="number" min="1" max="4" step="0.1" value={panel.zoom} onChange={(event) => updatePanel(index, { zoom: Math.max(1, Math.min(4, Number(event.target.value))) })} />
                  </label>
                  <label className="field" style={{ flex: 1 }}>Effect
                    <select className="text-input" value={title.effect} onChange={(event) => updatePanel(index, { title: { ...title, effect: event.target.value as BoardKeywordEffect } })}>
                      <option value="none">None</option>
                      <option value="fadeQuick">Quick fade</option>
                      <option value="type">Typed</option>
                      {(Object.keys(EFFECT_FAMILIES) as EffectFamily[]).map((family) => (
                        <optgroup key={family} label={EFFECT_FAMILY_LABELS[family]}>
                          {EFFECT_FAMILIES[family].map((effect) => <option key={effect} value={effect}>{TEXT_ANIMATION_LABELS[effect]}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                  <label className="field">Words
                    <select className="text-input" value={title.side} onChange={(event) => updatePanel(index, { title: { ...title, side: event.target.value as "left" | "right" } })}>
                      <option value="left">Left</option>
                      <option value="right">Right</option>
                    </select>
                  </label>
                  <label className="field">
                    <span><input type="checkbox" checked={panel.mirror} onChange={(event) => updatePanel(index, { mirror: event.target.checked })} /> Mirror</span>
                  </label>
                </div>
                <button type="button" className="btn btn-quiet small" disabled={board.panels.length <= 1} onClick={() => send({ ...board, panels: board.panels.filter((_, i) => i !== index) })}>Remove panel</button>
              </div>
            );
          })}
        </fieldset>
      ))}

      <fieldset className="stack" style={{ gap: 6, border: "none", padding: 0 }}>
        <legend className="small muted">Outro</legend>
        <label className="field">
          <span><input type="checkbox" checked={Boolean(board.outro)} data-testid="board-outro" onChange={(event) => {
            if (event.target.checked) update({ outro: { atMs: Math.max(board.startMs + 1, board.endMs - 3000), handle: "@reelwalking", glyph: "instagram", dimTo: 0.25 } });
            else {
              const rest = { ...board };
              delete rest.outro;
              send(rest);
            }
          }} /> Dim the board under your handle at the end</span>
        </label>
        {board.outro ? (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="field" style={{ flex: 1 }}>Handle
              <input className="text-input" maxLength={40} value={board.outro.handle} onChange={(event) => event.target.value.trim() && update({ outro: { ...board.outro!, handle: event.target.value } })} />
            </label>
            <label className="field">From (s)
              <input className="text-input" type="number" step="0.1" min="0" value={seconds(board.outro.atMs)} onChange={(event) => update({ outro: { ...board.outro!, atMs: toMs(event.target.value) } })} />
            </label>
          </div>
        ) : null}
      </fieldset>

      {error ? <p className="error small" role="alert">{error}</p> : null}
      <button type="button" className="btn btn-quiet btn-block" data-testid="board-remove" onClick={() => send(null)}>Remove the board</button>
    </Sheet>
  );
}
