"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { acceptFor } from "@reelwalk/core";
import { uploadFile } from "./editor/upload";
import { SparkIcon } from "./icons";

type Upload = { name: string; progress: number; assetId: string | null; error: string | null };
type Option = { reelId: string; title: string; angle: string; noteId: string };
type ThreadState = {
  working: { reply: string } | null;
  notes: { id: string; status: string; reply: string }[];
  versions: { exportId: string; status: string; label: string }[];
};

const EXAMPLES = [
  "Just listed: a 3-bed weatherboard cottage in Fitzroy with a north-facing garden. Open home Saturday 10am.",
  "Five reasons buyers love living near the beach in Cronulla.",
  "A day at our café: first coffee at 6am to the last pastry, cosy and warm.",
];

/** Where one option is, from its reel's thread: the run, then the render, then ready. */
function stage(thread: ThreadState | null, noteId: string): { label: string; done: boolean; failed: boolean; exportId: string | null; reply: string | null } {
  if (!thread) return { label: "Starting…", done: false, failed: false, exportId: null, reply: null };
  const note = thread.notes.find((entry) => entry.id === noteId);
  const version = thread.versions[0] ?? null;
  if (thread.working || note?.status === "working") return { label: "Finding footage and cutting it…", done: false, failed: false, exportId: null, reply: null };
  if (version?.status === "SUCCEEDED") return { label: "Ready", done: true, failed: false, exportId: version.exportId, reply: note?.reply ?? null };
  if (version?.status === "FAILED") return { label: "The render failed", done: true, failed: true, exportId: null, reply: note?.reply ?? null };
  if (version) return { label: "Rendering…", done: false, failed: false, exportId: null, reply: note?.reply ?? null };
  return { label: note?.status === "failed" ? "It did not work" : "No video was made", done: true, failed: true, exportId: null, reply: note?.reply ?? null };
}

function OptionCard({ option }: { option: Option }) {
  const [thread, setThread] = useState<ThreadState | null>(null);
  const current = stage(thread, option.noteId);

  useEffect(() => {
    if (current.done) return;
    let stopped = false;
    const poll = async () => {
      const answer = await fetch(`/api/reels/${option.reelId}/notes`, { cache: "no-store" }).then((response) => (response.ok ? response.json() : null)).catch(() => null);
      if (!stopped && answer?.ok) setThread(answer as ThreadState);
    };
    void poll();
    const timer = setInterval(poll, 4000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [option.reelId, current.done]);

  return (
    <li className="card create-option" data-testid="create-option" data-done={current.done ? "true" : "false"}>
      <div className="create-option-head">
        {current.exportId ? (
          <img src={`/api/renders/${current.exportId}/frames?t=1000ms&w=180`} alt="" width={90} height={160} className="create-poster" />
        ) : (
          <span className="create-poster create-poster-empty" aria-hidden="true" />
        )}
        <div>
          <p className="small muted">{option.angle}</p>
          <p className="create-option-title">{option.title}</p>
          <p className={current.failed ? "error small" : "small"} role="status">
            {current.label}
          </p>
        </div>
      </div>
      {current.reply ? <p className="small muted">{current.reply}</p> : null}
      <div className="create-option-actions">
        {current.exportId ? (
          <Link href={`/reels/${option.reelId}/export`} className="btn" prefetch={false} data-testid="create-open-export">
            Watch, change and post
          </Link>
        ) : null}
        <Link href={`/reels/${option.reelId}`} className="btn btn-quiet" prefetch={false}>
          Open in the editor
        </Link>
      </div>
    </li>
  );
}

/**
 * Create (ADR 0098): describe a video, optionally add photos or videos, and
 * get up to three short options, each a reel with its first version rendered.
 * Each option opens on the export screen, where it is posted or scheduled and
 * where a note changes it.
 */
export function CreateStudio({ available }: { available: boolean }) {
  const [idea, setIdea] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [count, setCount] = useState(3);
  const [captions, setCaptions] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const uploading = uploads.some((upload) => !upload.assetId && !upload.error);

  function addFiles(files: File[]) {
    const start = uploads.length;
    setUploads((list) => [...list, ...files.map((file) => ({ name: file.name, progress: 0, assetId: null, error: null }))]);
    files.forEach((file, offset) => {
      const index = start + offset;
      const patch = (next: Partial<Upload>) => setUploads((list) => list.map((upload, at) => (at === index ? { ...upload, ...next } : upload)));
      uploadFile(file, (progress) => patch({ progress }))
        .then((asset) => patch({ assetId: asset.id, progress: 1 }))
        .catch((reason: unknown) => patch({ error: reason instanceof Error ? reason.message : "Upload failed" }));
    });
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idea, mediaIds: uploads.flatMap((upload) => (upload.assetId ? [upload.assetId] : [])), options: count, captions }),
      });
      const answer = (await response.json().catch(() => null)) as { ok?: boolean; message?: string; options?: Option[]; skipped?: number } | null;
      if (!answer?.ok || !answer.options) {
        setError(answer?.message ?? "Could not start. Check your connection and try again.");
        return;
      }
      setOptions(answer.options);
      if (answer.skipped) setNotice(`${answer.skipped} option(s) could not start: ${answer.message ?? "the month's AI requests ran out"}.`);
    } catch {
      setError("Could not start. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (options.length) {
    return (
      <section aria-label="Your options">
        <p className="muted" style={{ marginBottom: 12 }}>
          Each option takes a few minutes: it finds footage, cuts it, then renders. You can leave this page; they also appear in your reels.
        </p>
        {notice ? <p className="small muted" role="status">{notice}</p> : null}
        <ul className="create-options">
          {options.map((option) => (
            <OptionCard key={option.reelId} option={option} />
          ))}
        </ul>
        <button type="button" className="btn btn-quiet" onClick={() => { setOptions([]); setIdea(""); setUploads([]); }} data-testid="create-again">
          Make something else
        </button>
      </section>
    );
  }

  return (
    <section className="create-form" aria-label="Describe your video">
      <label className="field">
        What should the video be?
        <textarea
          className="text-input"
          rows={4}
          maxLength={1000}
          value={idea}
          onChange={(event) => setIdea(event.target.value)}
          placeholder={EXAMPLES[0]}
          disabled={!available || busy}
          data-testid="create-idea"
        />
      </label>
      <div className="create-examples">
        {EXAMPLES.map((example) => (
          <button key={example} type="button" className="chip" onClick={() => setIdea(example)} disabled={!available || busy}>
            {example.split(":")[0].split(" ").slice(0, 5).join(" ")}…
          </button>
        ))}
      </div>

      <label className="btn btn-quiet create-upload">
        Add photos or videos (optional)
        <input
          type="file"
          multiple
          accept={acceptFor(["IMAGE", "VIDEO"])}
          disabled={!available || busy}
          data-testid="create-files"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length) addFiles(files);
          }}
        />
      </label>
      {uploads.length ? (
        <ul className="create-uploads small">
          {uploads.map((upload, index) => (
            <li key={`${upload.name}-${index}`}>
              {upload.name}: {upload.error ? <span className="error">{upload.error}</span> : upload.assetId ? "ready" : `${Math.round(upload.progress * 100)}%`}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">No footage? It finds free stock clips and library shots to fit the idea.</p>
      )}

      <div className="create-settings">
        <label className="field">
          Options
          <select className="text-input" value={count} onChange={(event) => setCount(Number(event.target.value))} disabled={busy} data-testid="create-count">
            <option value={1}>1 video</option>
            <option value={2}>2 videos</option>
            <option value={3}>3 videos, three angles</option>
          </select>
        </label>
        <label className="create-check">
          <input type="checkbox" checked={captions} onChange={(event) => setCaptions(event.target.checked)} disabled={busy} data-testid="create-captions" />
          Captions on screen
        </label>
      </div>

      <button
        type="button"
        className="btn btn-block"
        disabled={!available || busy || uploading || idea.trim().length < 10}
        onClick={submit}
        data-testid="create-submit"
      >
        <SparkIcon size={18} />
        {busy ? "Starting…" : uploading ? "Uploading…" : count === 1 ? "Make the video" : `Make ${count} videos`}
      </button>
      <p className="small muted">Each video uses one of this month's AI requests. Nothing is posted until you post it.</p>
      {!available ? <p className="error small">Create needs AI, which is off for this workspace or not set up here.</p> : null}
      {error ? (
        <p className="error small" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
