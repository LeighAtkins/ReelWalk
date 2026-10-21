"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clipDurationMs, lightFromLuma, planScript, scriptQuote, scriptSlots, SCRIPT_LINE_MAX, SCRIPT_LINE_MIN, SCRIPT_MAX_LINES, SCRIPT_OUTFIT_MAX,
  type LightSide, type PresenterTakeInsert, type ScriptRequest, type ScriptSlot, type ScriptVoice, type Timeline,
} from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { PresenterPicker } from "./presenter-kit";
import { luminance, timelineFrames } from "./frame-service";
import { loadApproved, progressSummary, saveApproved, scriptProgress, scriptSettled, shouldStartMore, takesToPlace, type ApprovedScript, type ScriptJob, type TakeState } from "./script-flow";

const POLL_MS = 10_000;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

/**
 * An approved script's takes, followed while the editor is open (not only the
 * sheet): starts the next take when the workspace has room, and says when the
 * takes are ready to place.
 */
export function useScriptRun(reelId: string) {
  const [approved, setApproved] = useState<ApprovedScript | null>(null);
  const [progress, setProgress] = useState<TakeState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const starting = useRef(false);
  useEffect(() => { setApproved(loadApproved(reelId)); }, [reelId]);

  const send = useCallback(async (next: ApprovedScript): Promise<{ ok: boolean; message?: string }> => {
    if (starting.current) return { ok: false };
    starting.current = true;
    try {
      const response = await fetch(`/api/reels/${reelId}/script`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...next, approved: true }) });
      const data = await response.json().catch(() => ({})) as { error?: string; started?: unknown[] };
      if (response.ok) return { ok: true };
      // Takes already started keep going; the same approval carries on later without charging them twice.
      return { ok: Boolean(data.started?.length), message: data.error ?? "Could not start the takes." };
    } catch { return { ok: false, message: "No connection. Try again." }; }
    finally { starting.current = false; }
  }, [reelId]);

  const refresh = useCallback(async (current: ApprovedScript) => {
    const response = await fetch("/api/ai/generations", { cache: "no-store" }).catch(() => null);
    if (!response?.ok) return;
    const data = await response.json() as { jobs: ScriptJob[] };
    const next = scriptProgress(current.script, data.jobs);
    setProgress(next);
    if (shouldStartMore(next, data.jobs)) {
      const sent = await send(current);
      setError(sent.ok ? null : sent.message ?? null);
    }
  }, [send]);

  const settled = progress.length > 0 && scriptSettled(progress);
  useEffect(() => {
    if (!approved || settled) return;
    void refresh(approved);
    const timer = setInterval(() => { void refresh(approved); }, POLL_MS);
    return () => clearInterval(timer);
  }, [approved, settled, refresh]);

  const start = useCallback(async (next: ApprovedScript) => {
    setError(null);
    const sent = await send(next);
    if (!sent.ok) { setError(sent.message ?? "Could not start the takes."); return false; }
    saveApproved(reelId, next); setApproved(next); setProgress([]); setError(sent.message ?? null);
    return true;
  }, [reelId, send]);

  const finish = useCallback(() => { saveApproved(reelId, null); setApproved(null); setProgress([]); setError(null); }, [reelId]);
  const toPlace = useMemo(() => approved && settled ? takesToPlace(approved.script, progress) : [], [approved, settled, progress]);
  return { approved, progress, settled, error, start, finish, toPlace, assets: progress.flatMap(take => take.asset ? [take.asset] : []) };
}
export type ScriptRun = ReturnType<typeof useScriptRun>;

type Availability = { enabled: boolean; voices: { veo: boolean; lipsync: boolean }; remaining: number };

/** The plate's key light, measured on a small analysis frame; null when it cannot be read. */
async function measureLight(timeline: Timeline, library: Record<string, LibraryAsset>, slot: ScriptSlot): Promise<LightSide | null> {
  try {
    const assets = Object.fromEntries(Object.values(library).map(asset => [asset.id, { src: asset.url, kind: asset.kind }]));
    const canvas = await timelineFrames(timeline, assets).frameAt(slot.plateClipId, slot.plate.atMs, { width: 48, height: 85, purpose: "analysis" });
    return canvas ? lightFromLuma(luminance(canvas)) : null;
  } catch { return null; }
}

function slotLabel(slot: ScriptSlot, slots: ScriptSlot[], timeline: Timeline): string {
  if (slot === slots[0] && slot.boundary === 0) return `Opening${slot.room ? ` · ${slot.room}` : ""}`;
  if (slot.boundary === timeline.clips.length) return `Closing${slot.room ? ` · ${slot.room}` : ""}`;
  const next = timeline.clips[slot.boundary]?.room;
  return `${clock(slot.atMs)} · after ${slot.room ?? `clip ${slot.boundary}`}${next && next !== slot.room ? ` → ${next}` : ""}`;
}

const OUTFIT_KEY = (kitId: string) => `reelwalk:outfit:${kitId}`;

/**
 * Script mode (ADR 0060), opened from the timeline's Presenter button: two to
 * four lines, where each one plays, the outfit, the voice, the quote, and
 * Generate. While takes are being made it shows them; when they are done it
 * places them in one undoable step.
 */
export function ScriptSheet({ reelId, timeline, library, run, onPlace, onAssets }: {
  reelId: string; timeline: Timeline; library: Record<string, LibraryAsset>; run: ScriptRun;
  onPlace(takes: PresenterTakeInsert[], assets: LibraryAsset[]): boolean; onAssets(assets: LibraryAsset[]): void;
}) {
  const [info, setInfo] = useState<Availability | null>(null);
  const [lines, setLines] = useState<string[]>(["", ""]);
  const [placements, setPlacements] = useState<(number | null)[]>([null, null]);
  const [outfit, setOutfit] = useState("");
  const [voice, setVoice] = useState<ScriptVoice>("veo");
  const [presenterId, setPresenterId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"write" | "generate" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const libraryList = useMemo(() => Object.values(library), [library]);

  useEffect(() => {
    void fetch(`/api/reels/${reelId}/script`, { cache: "no-store" }).then(r => r.ok ? r.json() : null).then((data: Availability | null) => setInfo(data)).catch(() => setInfo(null));
  }, [reelId, run.approved]);
  // The outfit she wore last time with this kit, so a new script keeps her look.
  useEffect(() => {
    if (!presenterId) return;
    try { const saved = localStorage.getItem(OUTFIT_KEY(presenterId)); if (saved) setOutfit(saved); } catch { /* none */ }
  }, [presenterId]);

  const slots = useMemo(() => scriptSlots(timeline), [timeline]);
  const filled = lines.map(line => line.trim());
  const planned = useMemo(() => planScript(slots, lines.length), [slots, lines.length]);
  // A line's place: the studio's choice while it is still a place in this reel, else the plan's.
  const chosen = lines.map((_, i) => slots.find(slot => slot.boundary === placements[i]) ?? planned[i]);
  const ordered = chosen.every((slot, i) => !slot || i === 0 || (chosen[i - 1] && slot.boundary >= chosen[i - 1]!.boundary));
  const quote = scriptQuote(filled);
  const linesOk = filled.every(line => line.length >= SCRIPT_LINE_MIN && line.length <= SCRIPT_LINE_MAX);
  const enough = info ? quote.total <= info.remaining : false;
  const canGenerate = Boolean(info?.enabled && presenterId && linesOk && ordered && slots.length && enough && !busy);

  function setLine(i: number, text: string) { setLines(current => current.map((line, j) => j === i ? text : line)); }
  function addLine() { if (lines.length < SCRIPT_MAX_LINES) { setLines(current => [...current, ""]); setPlacements(current => [...current, null]); } }
  function removeLine(i: number) { setLines(current => current.filter((_, j) => j !== i)); setPlacements(current => current.filter((_, j) => j !== i)); }

  async function write() {
    setBusy("write"); setMessage(null);
    try {
      const rooms = [...new Set(timeline.clips.map(clip => clip.room).filter((room): room is string => Boolean(room)))];
      const titles = timeline.texts.filter(text => !text.id.startsWith("room-")).map(text => text.text);
      const response = await fetch(`/api/reels/${reelId}/ideas`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "script", count: Math.max(2, lines.length), rooms, titles }) });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; lines?: string[]; message?: string };
      if (!data.ok || !data.lines?.length) { setMessage(data.message ?? "No lines came back. Try again."); return; }
      setLines(data.lines); setPlacements(data.lines.map(() => null));
    } finally { setBusy(null); }
  }

  async function generate() {
    if (!canGenerate || !presenterId) return;
    setBusy("generate"); setMessage(null);
    try {
      const lights = await Promise.all(chosen.map(slot => slot ? measureLight(timeline, library, slot) : Promise.resolve(null)));
      const script: ScriptRequest = {
        scriptId: crypto.randomUUID(), presenterId, voice, ...(outfit.trim() ? { outfit: outfit.trim() } : {}),
        takes: chosen.map((slot, i) => ({ line: filled[i], boundary: slot!.boundary, afterClipId: slot!.afterClipId, fraction: slot!.fraction, plate: slot!.plate, room: slot!.room, light: lights[i] })),
      };
      try { if (outfit.trim()) localStorage.setItem(OUTFIT_KEY(presenterId), outfit.trim()); } catch { /* none */ }
      if (await run.start({ script, quotedCredits: quote.total })) { setLines(["", ""]); setPlacements([null, null]); }
    } finally { setBusy(null); }
  }

  if (run.approved) {
    const ready = run.toPlace.length;
    return <div className="script-sheet">
      <p className="small">{plural(run.approved.script.takes.length, "take")} · {plural(run.approved.quotedCredits, "credit")} approved · {progressSummary(run.progress)}</p>
      <ol className="script-takes">
        {run.approved.script.takes.map((take, i) => {
          const state = run.progress[i]?.state ?? "waiting";
          return <li key={i}>
            <span className={`badge badge-${state === "ready" ? "succeeded" : state === "failed" ? "failed" : state === "making" ? "running" : "queued"}`}>{state === "ready" ? "Ready" : state === "failed" ? "Did not come out" : state === "making" ? "Being made" : "Waiting"}</span>
            <span className="script-take-line">“{take.line}”</span>
            {state === "failed" && run.progress[i]?.error ? <span className="small muted">{run.progress[i]!.error}</span> : null}
          </li>;
        })}
      </ol>
      {!run.settled ? <p className="small muted">Takes are made two at a time and take a few minutes each. You can keep editing; this carries on while the editor is open.</p> : null}
      {run.error ? <p role="status" className="small">{run.error}</p> : null}
      {run.settled && ready > 0 ? <button type="button" className="btn btn-signal btn-block" onClick={() => { if (onPlace(run.toPlace, run.assets)) run.finish(); }}>Put {plural(ready, "take")} in the reel</button> : null}
      {run.settled ? <button type="button" className="btn btn-quiet btn-block" onClick={run.finish}>{ready > 0 ? "Don't place them (they stay in Media)" : "Write a new script"}</button> : null}
    </div>;
  }

  return <div className="script-sheet">
    {info && !info.enabled ? <p className="small"><span className="badge badge-queued">Not yet</span> Voiced presenter takes are being connected. Please check back soon.</p> : null}
    {slots.length === 0 ? <p className="small">Add some of your own footage first: each line is filmed into the reel's own picture.</p> : null}
    <PresenterPicker library={libraryList} value={presenterId} onChange={setPresenterId} onAssets={onAssets} disabled={busy !== null} />

    <fieldset className="field" aria-label="Lines">
      <legend className="small">What she says · one take per line</legend>
      {lines.map((line, i) => {
        const slot = chosen[i];
        const plateAsset = slot ? library[slot.plate.assetId] : undefined;
        return <div key={i} className="script-line">
          <div className="script-line-head">
            {plateAsset?.thumbUrl ? <img className="script-plate" src={plateAsset.thumbUrl} alt="" /> : <span className="script-plate" aria-hidden="true" />}
            <select className="text-input" aria-label={`Where line ${i + 1} plays`} value={slot?.boundary ?? ""} onChange={e => setPlacements(current => current.map((p, j) => j === i ? Number(e.target.value) : p))}>
              {slots.map(s => <option key={s.boundary} value={s.boundary}>{slotLabel(s, slots, timeline)}</option>)}
            </select>
            {lines.length > 1 ? <button type="button" className="btn btn-quiet" aria-label={`Remove line ${i + 1}`} onClick={() => removeLine(i)}>×</button> : null}
          </div>
          <textarea className="text-area" rows={2} maxLength={SCRIPT_LINE_MAX} placeholder={i === 0 ? "Hi, I'm Maya. Come and see this one." : i === lines.length - 1 ? "Message me for a private tour." : "Wait until you see the kitchen."} value={line} onChange={e => setLine(i, e.target.value)} />
          <span className="small muted">{quote.seconds[i]}-second take · {plural(quote.credits[i], "credit")}{i > 0 && slot && chosen[i - 1]?.boundary === slot.boundary ? " · straight after the last one: she walks in from where it ended" : ""}</span>
        </div>;
      })}
      {!ordered ? <p className="small" role="status">Keep the lines in the order they play.</p> : null}
      <div className="script-actions">
        {lines.length < SCRIPT_MAX_LINES ? <button type="button" className="btn btn-quiet" onClick={addLine}>Add a line</button> : null}
        <button type="button" className="btn btn-quiet" disabled={busy !== null} onClick={() => { void write(); }}>{busy === "write" ? "Writing…" : "Write them for me"}</button>
      </div>
    </fieldset>

    <ScriptStrip timeline={timeline} slots={chosen} />

    <label className="field">
      <span className="small">What she wears (the same in every take)</span>
      <input className="text-input" maxLength={SCRIPT_OUTFIT_MAX} placeholder="e.g. a cream linen blazer, white tee, light jeans" value={outfit} onChange={e => setOutfit(e.target.value)} />
    </label>

    <fieldset className="field" aria-label="Voice">
      <legend className="small">Her voice (one voice for every take)</legend>
      <label className="small"><input type="radio" name="script-voice" checked={voice === "veo"} onChange={() => setVoice("veo")} /> Veo's own voice, warm Australian accent</label>
      {info?.voices.lipsync ? <label className="small"><input type="radio" name="script-voice" checked={voice === "lipsync"} onChange={() => setVoice("lipsync")} /> Your presenter voice, lip-synced</label> : null}
    </fieldset>

    <p className="small script-quote">
      {plural(lines.length, "take")} · <strong>{plural(quote.total, "credit")}</strong> in total{info ? ` · you have ${info.remaining}` : ""}. Each face is checked against her kit before a credit is spent; a take that does not come out is refunded.
    </p>
    {info && info.enabled && !enough ? <p className="small" role="status">Not enough credits for the whole script. Add credits in Account or shorten a line.</p> : null}
    {run.error || message ? <p role="status" className="small">{run.error ?? message}</p> : null}
    <button type="button" className="btn btn-signal btn-block" disabled={!canGenerate} onClick={() => { void generate(); }}>
      {busy === "generate" ? "Starting…" : `Generate · ${plural(quote.total, "credit")}`}
    </button>
  </div>;
}

/** Where the lines play: the reel as a bar, a numbered mark at each line's place. */
function ScriptStrip({ timeline, slots }: { timeline: Timeline; slots: (ScriptSlot | undefined)[] }) {
  const counts = new Map<number, number>();
  return <div className="script-strip" aria-label="Where the lines play">
    {timeline.clips.map((clip, i) => <span key={clip.id} className="script-strip-clip" style={{ flexGrow: clipDurationMs(clip) }} title={clip.room ?? `Clip ${i + 1}`} />)}
    {slots.map((slot, i) => {
      if (!slot) return null;
      const stack = counts.get(slot.boundary) ?? 0; counts.set(slot.boundary, stack + 1);
      return <span key={i} className="script-strip-mark" style={{ left: `calc(${(slot.fraction * 100).toFixed(2)}% + ${stack * 14}px)` }}>{i + 1}</span>;
    })}
  </div>;
}
