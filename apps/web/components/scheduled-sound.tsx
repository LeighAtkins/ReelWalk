"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { instagramAudioLabel, type InstagramAudioChoice } from "@reelwalk/core";
import { scheduledSoundPreview, setScheduledSound } from "@/app/scheduled-actions";
import { InstagramSoundPicker } from "./instagram-sound-picker";
import { SoundComparison } from "./sound-comparison";

/** Audition changes locally; only Save changes the queued post. */
export function ScheduledSound({ postId, initial }: { postId: string; initial: InstagramAudioChoice | null }) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function edit() {
    setDraft(saved);
    setError(null);
    setNotice(null);
    setOpen(true);
    startTransition(async () => {
      const result = await scheduledSoundPreview(postId).catch(() => ({ ok: false as const, error: "Could not load the preview. Try again." }));
      if (result.ok) setUrl(result.url);
      else setError(result.error);
    });
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await setScheduledSound({ id: postId, audio: draft }).catch(() => ({ ok: false as const, error: "Could not save. Try again." }));
      if (!result.ok) setError(result.error);
      else {
        setSaved(draft);
        setOpen(false);
        setNotice("Music saved. Posting time unchanged.");
        router.refresh();
      }
    });
  }

  return (
    <div className="scheduled-sound" data-testid="scheduled-sound">
      <span className="small">{saved ? instagramAudioLabel(saved) : "Original export audio"}</span>
      <button type="button" className="btn btn-quiet" onClick={edit} disabled={pending || open} data-testid="scheduled-music-edit">Change music &amp; preview</button>
      {open ? (
        <div className="scheduled-music-panel" data-testid="scheduled-music-panel">
          <InstagramSoundPicker value={draft} onChange={setDraft} disabled={pending} onOpenChange={setPicking} />
          {picking ? null : url ? <SoundComparison key={draft?.audioId ?? "original"} src={url} sound={draft} /> : <p className="muted small" role="status">{pending ? "Loading reel preview..." : "Reel preview unavailable. Close and try again."}</p>}
          <p className="muted small">Preview changes before saving. Instagram adds the chosen music when it posts; the downloaded MP4 keeps its original audio.</p>
          <div className="row">
            <button type="button" className="btn" disabled={pending} onClick={save} data-testid="scheduled-music-save">{pending ? "Please wait..." : "Save music"}</button>
            <button type="button" className="btn btn-quiet" disabled={pending} onClick={() => { setOpen(false); setError(null); }}>Cancel changes</button>
          </div>
        </div>
      ) : null}
      {notice ? <p className="small" role="status">{notice}</p> : null}
      {error ? <p className="error small" role="alert">{error}</p> : null}
    </div>
  );
}
