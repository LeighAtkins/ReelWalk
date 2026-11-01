"use client";

import { useEffect, useState } from "react";
import type { StyleReferenceView } from "@/lib/style-references";
import { uploadFile } from "./editor/upload";

type Pending = { name: string; progress: number; error: string | null };

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const STATUS: Record<StyleReferenceView["status"], string> = {
  measuring: "Measuring cuts, pace and speech…",
  reading: "Reading its titles…",
  ready: "Ready",
  failed: "Could not be read",
};

/**
 * Style references (ADR 0102). The owner downloads the reel themselves and shares or uploads it here; a pasted link is
 * kept only as a note of where it came from. Each reference is followed until its recipe is read.
 */
export function StyleReferences({ initial, available }: { initial: StyleReferenceView[]; available: boolean }) {
  const [references, setReferences] = useState(initial);
  const [pending, setPending] = useState<Pending | null>(null);
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reading = references.some((r) => r.status === "measuring" || r.status === "reading");

  // Follow the references being read until each is ready or failed.
  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(async () => {
      const answer = await fetch("/api/references", { cache: "no-store" }).then((r) => r.json()).catch(() => null) as { ok?: boolean; references?: StyleReferenceView[] } | null;
      if (answer?.ok && answer.references) setReferences(answer.references);
    }, 4000);
    return () => clearInterval(timer);
  }, [reading]);

  async function add(file: File) {
    setError(null);
    setPending({ name: file.name, progress: 0, error: null });
    try {
      const asset = await uploadFile(file, (progress) => setPending((p) => (p ? { ...p, progress } : p)));
      const response = await fetch("/api/references", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mediaAssetId: asset.id, sourceUrl: link || null, title: file.name.replace(/\.[^.]+$/, "") }),
      });
      const answer = await response.json().catch(() => null) as { ok?: boolean; message?: string; reference?: StyleReferenceView } | null;
      if (!response.ok || !answer?.ok || !answer.reference) throw new Error(answer?.message ?? "The reference could not be added.");
      const added = answer.reference;
      setReferences((list) => [added, ...list.filter((r) => r.id !== added.id)]);
      setLink("");
      setPending(null);
    } catch (reason) {
      setPending(null);
      setError(reason instanceof Error ? reason.message : "Upload failed");
    }
  }

  return (
    <>
      <section className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Add a reel</h2>
        <ol className="small" style={{ paddingLeft: 18, marginTop: 0 }} data-testid="reference-steps">
          <li>In Instagram, open the reel, tap Share (the paper plane) and choose <b>Download</b>. If it is not offered, save it with your phone&apos;s screen recording.</li>
          <li>Come back here and upload the saved video below (on your phone it is in your camera roll or Downloads).</li>
          <li>Optional: paste the reel&apos;s link so you remember where it came from. ReelWalk keeps it as a note only.</li>
        </ol>
        <p className="small muted">The reel is only read for its style. It is never added to your library, used in a reel or posted.</p>
        <label className="field">
          Link to the reel (optional)
          <input className="text-input" type="url" inputMode="url" placeholder="https://www.instagram.com/reel/…" value={link} onChange={(e) => setLink(e.target.value)} disabled={!!pending} data-testid="reference-link" />
        </label>
        <label className={`btn ${available && !pending ? "" : "btn-disabled"}`} style={{ marginTop: 8 }}>
          {pending ? `Uploading ${pending.name}: ${Math.round(pending.progress * 100)}%` : "Upload the reel's video"}
          <input
            type="file"
            accept="video/*"
            hidden
            disabled={!available || !!pending}
            data-testid="reference-file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void add(file);
            }}
          />
        </label>
        {!available ? <p className="small muted">AI is off for this workspace, so references cannot be read.</p> : null}
        {error ? <p className="small error">{error}</p> : null}
      </section>

      {references.length === 0 ? (
        <p className="muted small">No references yet.</p>
      ) : (
        <ul className="reference-list" style={{ listStyle: "none", padding: 0, display: "grid", gap: 12 }}>
          {references.map((reference) => (
            <li key={reference.id} className="card" data-testid="reference">
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                <strong>{reference.title ?? "Reference"}</strong>
                <span className={`small ${reference.status === "failed" ? "error" : "muted"}`}>{STATUS[reference.status]}</span>
              </div>
              {reference.sourceUrl ? <p className="small muted" style={{ margin: "4px 0", overflowWrap: "anywhere" }}>From {reference.sourceUrl}</p> : null}
              {reference.error ? <p className="small error">{reference.error}</p> : null}
              {reference.recipe ? <RecipeView reference={reference} /> : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function RecipeView({ reference }: { reference: StyleReferenceView }) {
  const recipe = reference.recipe!;
  return (
    <div className="small" data-testid="recipe">
      <p style={{ whiteSpace: "pre-line" }}>{reference.summary}</p>
      {/* The shots as a strip, each as wide as it is long. */}
      <div style={{ display: "flex", height: 10, borderRadius: 4, overflow: "hidden", margin: "8px 0" }} aria-label="Shots">
        {recipe.shots.map((shot, i) => (
          <span key={i} title={`${seconds(shot.startMs)} to ${seconds(shot.endMs)}`} style={{ flex: shot.endMs - shot.startMs, background: i % 2 ? "var(--muted, #888)" : "var(--accent, #c9a227)", opacity: 0.35 + 0.65 * Math.min(1, (shot.motion ?? 0) * 8) }} />
        ))}
      </div>
      {recipe.titles.length ? (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th align="left">Title</th><th align="left">When</th><th align="left">Effect</th></tr></thead>
          <tbody>
            {recipe.titles.map((title, i) => (
              <tr key={i}>
                <td>{title.text}{title.look ? <span className="muted"> · {title.look}</span> : null}</td>
                <td>{seconds(title.startMs)}–{seconds(title.endMs)}</td>
                <td>{title.effect}{title.effectNote ? <span className="muted"> · {title.effectNote}</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {reference.gaps.length ? (
        <p className="muted" data-testid="recipe-gaps">Not drawn by ReelWalk yet: {reference.gaps.map((g) => g.effect).join(", ")}.</p>
      ) : null}
    </div>
  );
}
