"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { acceptFor, vibeById, VIBES } from "@reelwalk/core";
import { createReel, createReelFromTour } from "@/app/actions";
import { setPendingFiles } from "@/lib/pending-files";
import { DishIcon, PanoIcon, PlusIcon, SparkIcon } from "./icons";

/**
 * The way Instagram starts a reel: pick photos and videos first, then edit.
 * The editor opens straight away and uploads the files there, with progress
 * on the timeline.
 */
export function NewReelPicker({ librarySize = 0, tours = [] }: { librarySize?: number; tours?: { id: string; name: string; rooms: number }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vibeId, setVibeId] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const autoInput = useRef<HTMLInputElement>(null);

  async function start(files: File[], autopilot = false) {
    setBusy(true);
    setError(null);
    try {
      const { id } = await createReel();
      setPendingFiles(id, files);
      router.push(autopilot ? `/reels/${id}?auto=1` : `/reels/${id}`);
    } catch {
      setError("Could not start a reel. Check your connection and try again.");
      setBusy(false);
    }
  }

  // Files picked before the page finished loading never reached onChange:
  // pick them up as soon as it can, rather than losing the tap.
  useEffect(() => {
    for (const [element, autopilot] of [
      [autoInput.current, true],
      [input.current, false],
    ] as const) {
      const files = Array.from(element?.files ?? []);
      if (!element || files.length === 0) continue;
      element.value = "";
      void start(files, autopilot);
      return;
    }
    // Once, on mount; start() itself is recreated each render.
  }, []);

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
    const result = await createReelFromTour({ tourId, vibeId: vibeId || undefined }).catch(() => ({ error: "Could not build the reel. Check your connection and try again." }));
    if ("error" in result) {
      setError(result.error);
      setBusy(false);
      return;
    }
    router.push(`/reels/${result.id}`);
  }

  return (
    <section className="start" aria-label="Start a reel">
      {/* Make it for me (ADR 0021): pick the shots, and ReelWalk does the rest through to the render. */}
      <label className="start-primary start-auto" data-busy={busy}>
        <span className="viewfinder" aria-hidden="true">
          <SparkIcon size={22} />
        </span>
        <span className="start-text">
          <span className="start-title">{busy ? "Opening…" : "Make it for me"}</span>
          <span className="start-sub">Pick your shots. ReelWalk cuts them to music, adds the text and renders it.</span>
        </span>
        <input
          ref={autoInput}
          type="file"
          multiple
          accept={acceptFor(["IMAGE", "VIDEO"])}
          disabled={busy}
          aria-label="Make it for me: pick photos and videos"
          data-testid="autopilot-input"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length > 0) void start(files, true);
          }}
        />
      </label>

      {/* The whole bar is the file picker: one tap opens the phone's photos. */}
      <label className="start-primary start-manual" data-busy={busy}>
        <span className="viewfinder" aria-hidden="true">
          <PlusIcon size={22} />
        </span>
        <span className="start-text">
          <span className="start-title">{busy ? "Opening…" : "New reel"}</span>
          <span className="start-sub">Pick photos and videos and edit them yourself</span>
        </span>
        <input
          ref={input}
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

      <div className="start-more">
        {librarySize > 0 ? (
          <button type="button" className="start-tile" disabled={busy} onClick={startFromLibrary} data-testid="start-from-library">
            <PanoIcon size={20} />
            <span className="start-tile-title">Starter library</span>
            <span className="start-tile-sub">360 rooms and songs</span>
          </button>
        ) : null}
        <Link href="/new/venue" className="start-tile" prefetch={false} data-testid="new-venue-reel">
          <DishIcon size={20} />
          <span className="start-tile-title">Restaurant or café</span>
          <span className="start-tile-sub">From your menu</span>
        </Link>
      </div>

      {tours.length > 0 ? (
        <div className="start-tours">
          <label className="field">
            Vibe for an auto-built tour
            <select className="text-input" value={vibeId} onChange={(event) => setVibeId(event.target.value)} disabled={busy} data-testid="vibe">
              <option value="">Neutral</option>
              {VIBES.map((vibe) => (
                <option key={vibe.id} value={vibe.id}>
                  {vibe.name}
                </option>
              ))}
            </select>
            {vibeById(vibeId) ? <span className="muted small">{vibeById(vibeId)!.audience}</span> : null}
          </label>
          {tours.map((tour) => (
            <button key={tour.id} type="button" className="btn btn-quiet btn-block" disabled={busy} onClick={() => buildFromTour(tour.id)} data-testid="auto-build">
              Auto-build a tour of {tour.name}
            </button>
          ))}
        </div>
      ) : null}
      {error ? (
        <p className="error small" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
