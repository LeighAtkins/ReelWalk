"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { acceptFor } from "@reelwalk/core";
import { createReel, createReelFromTour } from "@/app/actions";
import { setPendingFiles } from "@/lib/pending-files";
import { PlusIcon } from "./icons";

/**
 * The way Instagram starts a reel: pick photos and videos first, then edit.
 * The editor opens straight away and uploads the files there, with progress
 * on the timeline.
 */
export function NewReelPicker({ librarySize = 0, tours = [] }: { librarySize?: number; tours?: { id: string; name: string; rooms: number }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(files: File[]) {
    setBusy(true);
    setError(null);
    try {
      const { id } = await createReel();
      setPendingFiles(id, files);
      router.push(`/reels/${id}`);
    } catch {
      setError("Could not start a reel. Check your connection and try again.");
      setBusy(false);
    }
  }

  async function startFromLibrary() {
    setBusy(true);
    setError(null);
    try {
      const { id } = await createReel();
      router.push(`/reels/${id}?library=1`);
    } catch {
      setError("Could not start a reel. Check your connection and try again.");
      setBusy(false);
    }
  }

  async function buildFromTour(tourId: string) {
    setBusy(true);
    setError(null);
    const result = await createReelFromTour({ tourId }).catch(() => ({ error: "Could not build the reel. Check your connection and try again." }));
    if ("error" in result) {
      setError(result.error);
      setBusy(false);
      return;
    }
    router.push(`/reels/${result.id}`);
  }

  return (
    <div className="new-reel-stack">
      <label className="new-reel" data-busy={busy}>
        <span className="plus">
          <PlusIcon size={26} />
        </span>
        <span>{busy ? "Opening…" : "New reel"}</span>
        <span className="muted small">Pick photos and videos</span>
        <input
          type="file"
          multiple
          accept={acceptFor(["IMAGE", "VIDEO"])}
          disabled={busy}
          aria-label="New reel: pick photos and videos"
          data-testid="new-reel-input"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length > 0) void start(files);
          }}
        />
      </label>
      {librarySize > 0 ? (
        <button type="button" className="btn btn-quiet btn-block" disabled={busy} onClick={startFromLibrary} data-testid="start-from-library">
          Use library media
        </button>
      ) : null}
      {tours.map((tour) => (
        <button key={tour.id} type="button" className="btn btn-quiet btn-block" disabled={busy} onClick={() => buildFromTour(tour.id)} data-testid="auto-build">
          Auto-build a tour
        </button>
      ))}
      {error ? <p className="error small" role="alert">{error}</p> : null}
    </div>
  );
}
