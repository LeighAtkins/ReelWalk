"use client";

import { useEffect, useState } from "react";
import type { PlanShot } from "@reelwalk/core";
import type { ShotPlanView } from "@/lib/shot-plans";

type Media = Record<string, { url: string; thumbUrl: string | null; kind: string }>;

const WAITING: Record<string, string> = {
  storyboard: "The storyboard is ready. Check each start and end frame, then approve it to start the takes.",
  "take-approval": "A take passed its checks and waits for you.",
  "take-failed": "A shot failed its checks three times. Keep one of its takes anyway, or redo it with a note.",
  budget: "The next take would go past the budget.",
};
const STATUS: Record<string, string> = { planned: "Planned", running: "Making", waiting: "Waiting for you", done: "Done", stopped: "Stopped", failed: "Stopped on an error" };
const TRANSITION: Record<string, string> = { continuous: "carries on, no cut", cut: "cut", "match-cut": "match cut", whip: "whip", "speed-ramp": "speed ramp into the cut", dissolve: "dissolve" };

/**
 * A shot plan's storyboard (ADR 0104): every shot with its start and end frame, its move and the transition into the
 * next; the takes as they are made, with what their checks found; and the owner's decisions. Followed while it runs.
 */
export function ShotPlanBoard({ initial, initialMedia }: { initial: ShotPlanView; initialMedia: Media }) {
  const [view, setView] = useState(initial);
  const [media, setMedia] = useState(initialMedia);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  useEffect(() => {
    if (view.status !== "running") return;
    const timer = setInterval(async () => {
      const answer = await fetch(`/api/plans/${view.id}`, { cache: "no-store" }).then((r) => r.json()).catch(() => null) as { ok?: boolean; plan?: ShotPlanView; media?: Media } | null;
      if (answer?.ok && answer.plan) { setView(answer.plan); setMedia(answer.media ?? {}); }
    }, 6000);
    return () => clearInterval(timer);
  }, [view.id, view.status]);

  async function act(body: Record<string, unknown>) {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/plans/${view.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const answer = await response.json().catch(() => null) as { ok?: boolean; message?: string; plan?: ShotPlanView } | null;
      if (!response.ok || !answer?.ok || !answer.plan) throw new Error(answer?.message ?? "That could not be done.");
      setView(answer.plan);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That could not be done.");
    } finally { setBusy(false); }
  }

  const errors = view.issues.filter((i) => i.level === "error");
  const waitingReason = view.waitingFor?.split(":")[0] ?? null;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <section className="card" style={{ padding: 16 }}>
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <strong>{STATUS[view.status] ?? view.status}</strong>
          <span className="muted small">
            {view.credits.spent} of {view.budgetCredits} credits used · about {view.credits.once} if every take passes first time
          </span>
        </div>
        {view.status === "waiting" && waitingReason ? <p className="small" style={{ marginTop: 8 }}>{WAITING[waitingReason] ?? view.waitingFor}</p> : null}
        {view.error ? <p className="small" style={{ color: "var(--danger)", marginTop: 8 }}>{view.error}</p> : null}
        {view.issues.length ? (
          <ul className="small" style={{ marginTop: 8, paddingLeft: 18 }}>
            {view.issues.map((issue, i) => <li key={i} style={{ color: issue.level === "error" ? "var(--danger)" : undefined }}>{issue.shotId}: {issue.message}</li>)}
          </ul>
        ) : null}
        <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          {["planned", "stopped", "failed"].includes(view.status) ? (
            <button className="btn btn-primary" disabled={busy || errors.length > 0} onClick={() => act({ action: "start", confirmCredits: view.budgetCredits })}>
              Start · up to {view.budgetCredits} credits
            </button>
          ) : null}
          {waitingReason === "storyboard" ? <button className="btn btn-primary" disabled={busy} onClick={() => act({ action: "approve_storyboard" })}>Approve the storyboard</button> : null}
          {view.status === "running" || view.status === "waiting" ? <button className="btn btn-quiet" disabled={busy} onClick={() => act({ action: "stop" })}>Stop</button> : null}
          {view.reelId ? <a className="btn" href={`/reels/${view.reelId}`}>Open the reel</a> : null}
        </div>
        {error ? <p className="small" style={{ color: "var(--danger)", marginTop: 8 }}>{error}</p> : null}
      </section>

      {view.plan.shots.map((shot, i) => (
        <div key={shot.id} className="stack" style={{ gap: 6 }}>
          <ShotCard
            shot={shot} index={i} view={view} media={media} busy={busy} note={notes[shot.id] ?? ""}
            onNote={(note) => setNotes((all) => ({ ...all, [shot.id]: note }))}
            onKeep={(aiShotId) => act({ action: "accept_take", shotId: shot.id, aiShotId })}
            onRedo={() => act({ action: "redo", shotId: shot.id, ...(notes[shot.id] ? { note: notes[shot.id] } : {}) })}
          />
          {i < view.plan.shots.length - 1 ? (
            <p className="muted small" style={{ textAlign: "center" }}>
              ↓ {TRANSITION[shot.transitionOut.kind]}{shot.transitionOut.direction ? ` ${shot.transitionOut.direction}` : ""}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function Frame({ label, frame, previous, media }: { label: string; frame: PlanShot["start"]; previous?: boolean; media: Media }) {
  const item = frame.assetId ? media[frame.assetId] : undefined;
  return (
    <figure style={{ margin: 0, flex: 1, minWidth: 0 }}>
      <div style={{ aspectRatio: "9 / 16", background: "var(--surface-2, #1112)", borderRadius: 8, overflow: "hidden", display: "grid", placeItems: "center" }}>
        {item ? (
          <img src={item.thumbUrl ?? item.url} alt={frame.description} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <span className="muted small" style={{ padding: 8, textAlign: "center" }}>
            {previous ? "The last frame of the shot before" : frame.source === "free" ? "Wherever the take lands" : "Being made…"}
          </span>
        )}
      </div>
      <figcaption className="muted small" style={{ marginTop: 4 }}><strong>{label}:</strong> {frame.description}</figcaption>
    </figure>
  );
}

function ShotCard({ shot, index, view, media, busy, note, onNote, onKeep, onRedo }: {
  shot: PlanShot; index: number; view: ShotPlanView; media: Media; busy: boolean; note: string;
  onNote: (note: string) => void; onKeep: (aiShotId: string) => void; onRedo: () => void;
}) {
  const state = view.state.shots[shot.id];
  const takes = state?.takes ?? [];
  return (
    <section className="card" style={{ padding: 16 }}>
      <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <strong>{index + 1}. {shot.place}</strong>
        <span className="muted small">{shot.pov} · {shot.motion} · {shot.seconds} s{shot.playSeconds ? ` (plays ${shot.playSeconds} s)` : ""}</span>
      </div>
      <p className="small" style={{ marginTop: 6 }}>{shot.action}</p>
      {shot.line ? <p className="small" style={{ marginTop: 4 }}>She says: “{shot.line}”</p> : null}
      <div className="row" style={{ gap: 12, marginTop: 10, alignItems: "flex-start" }}>
        <Frame label="Start" frame={shot.start} previous={shot.start.source === "previous"} media={media} />
        <Frame label="End" frame={shot.end} media={media} />
      </div>
      {takes.length ? (
        <div className="stack" style={{ gap: 10, marginTop: 12 }}>
          {takes.map((take, n) => {
            const item = take.assetId ? media[take.assetId] : undefined;
            const kept = state?.acceptedAiShotId === take.aiShotId;
            return (
              <div key={take.aiShotId} className="row" style={{ gap: 10, alignItems: "flex-start" }}>
                {item ? <video src={item.url} muted loop playsInline controls style={{ width: 96, aspectRatio: "9 / 16", borderRadius: 6, background: "#000" }} /> : <div style={{ width: 96 }} />}
                <div className="small" style={{ flex: 1 }}>
                  <strong>Take {n + 1}</strong> · {kept ? "kept" : take.status}
                  {take.verdict?.problems.map((p, k) => <p key={k} style={{ color: "var(--danger)" }}>{p}</p>)}
                  {take.verdict?.notes.map((p, k) => <p key={k} className="muted">{p}</p>)}
                  {take.assetId && !kept && ["passed", "failed"].includes(take.status) ? (
                    <button className="btn btn-quiet small" disabled={busy} onClick={() => onKeep(take.aiShotId)}>Keep this take</button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {takes.length && view.status !== "planned" ? (
        <div className="row" style={{ gap: 8, marginTop: 10 }}>
          <input className="input" placeholder="What to change (optional)" value={note} maxLength={400} onChange={(e) => onNote(e.target.value)} style={{ flex: 1 }} />
          <button className="btn" disabled={busy} onClick={onRedo}>Redo this shot</button>
        </div>
      ) : null}
    </section>
  );
}

/** A new plan: the brief and how often to stop for the owner. */
export function NewShotPlan({ presenters }: { presenters: { id: string; name: string }[] }) {
  const [brief, setBrief] = useState("");
  const [approval, setApproval] = useState("storyboard");
  const [presenterId, setPresenterId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function plan() {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brief, approval, ...(presenterId ? { presenterId } : {}) }) });
      const answer = await response.json().catch(() => null) as { ok?: boolean; message?: string; plan?: { id: string } } | null;
      if (!response.ok || !answer?.ok || !answer.plan) throw new Error(answer?.message ?? "The plan could not be made.");
      window.location.href = `/plans/${answer.plan.id}`;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The plan could not be made.");
      setBusy(false);
    }
  }
  return (
    <section className="card stack" style={{ padding: 16, gap: 10 }}>
      <textarea className="input" rows={4} maxLength={2000} value={brief} onChange={(e) => setBrief(e.target.value)}
        placeholder="The video: the hook, the rooms, the mood and what the presenter says. For example: she says “Nice room, right? Now look up.” in the entrance hall, the camera tilts up to the chandelier, then flies through the living room, kitchen and terrace." />
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <select className="input" value={approval} onChange={(e) => setApproval(e.target.value)} aria-label="When to stop for you">
          <option value="storyboard">Stop after the storyboard</option>
          <option value="each-take">Stop after every take</option>
          <option value="auto">Make it all without stopping</option>
        </select>
        {presenters.length ? (
          <select className="input" value={presenterId} onChange={(e) => setPresenterId(e.target.value)} aria-label="Presenter">
            <option value="">No presenter</option>
            {presenters.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        ) : null}
        <button className="btn btn-primary" disabled={busy || brief.trim().length < 10} onClick={plan}>{busy ? "Planning…" : "Plan the shots"}</button>
      </div>
      <p className="muted small">Nothing is made or spent until you start it: you see every shot, its start and end frame and the cost first.</p>
      {error ? <p className="small" style={{ color: "var(--danger)" }}>{error}</p> : null}
    </section>
  );
}
