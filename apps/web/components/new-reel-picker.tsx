"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { acceptFor, vibeById, VIBES } from "@reelwalk/core";
import { createReel, createReelFromTour } from "@/app/actions";
import { setPendingFiles } from "@/lib/pending-files";
import { CheckIcon, DishIcon, PanoIcon, PlanIcon, PlusIcon, SparkIcon } from "./icons";

/**
 * The way Instagram starts a reel: pick photos and videos first, then edit.
 * The editor opens straight away and uploads the files there, with progress
 * on the timeline.
 *
 * One entry (ADR 0064): the main tile goes from the picked shots straight to
 * a finished first cut (music, titles, a hook), with no form; the editor opens
 * on it. Editing from an empty timeline is the quieter way in.
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
      {/* One tap from the shots to a finished first cut (ADR 0021, 0024, 0064). */}
      <label className="start-primary start-auto" data-busy={busy}>
        <span className="viewfinder" aria-hidden="true">
          <SparkIcon size={22} />
        </span>
        <span className="start-text">
          <span className="start-title">{busy ? "Opening…" : "New reel"}</span>
          <span className="start-sub">Pick your shots. ReelWalk makes the first cut, with music, titles and a hook; change anything after.</span>
        </span>
        <input
          ref={autoInput}
          type="file"
          multiple
          accept={acceptFor(["IMAGE", "VIDEO"])}
          disabled={busy}
          aria-label="New reel: pick photos and videos for a finished first cut"
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
          <span className="start-title">{busy ? "Opening…" : "Edit it yourself"}</span>
          <span className="start-sub">Pick photos and videos and start from an empty timeline</span>
        </span>
        <input
          ref={input}
          type="file"
          multiple
          accept={acceptFor(["IMAGE", "VIDEO"])}
          disabled={busy}
          aria-label="Edit it yourself: pick photos and videos"
          data-testid="new-reel-input"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length > 0) void start(files);
          }}
        />
      </label>

      <div className="start-more">
        {/* Create (ADR 0098): an idea in words, footage optional, short options out. */}
        <Link href="/create" className="start-tile" prefetch={false} data-testid="create-from-idea">
          <SparkIcon size={20} />
          <span className="start-tile-title">Describe a video</span>
          <span className="start-tile-sub">Type an idea, get options</span>
        </Link>
        {/* Style references (ADR 0102): a reel the owner downloaded and shared, read for its style. */}
        <Link href="/references" className="start-tile" prefetch={false} data-testid="follow-a-style">
          <SparkIcon size={20} />
          <span className="start-tile-title">Follow a reel&apos;s style</span>
          <span className="start-tile-sub">Share a reel you like</span>
        </Link>
        {/* Shoot assist (ADR 0063): an optional shot list before anything is filmed. */}
        <Link href="/new/shoot" className="start-tile" prefetch={false} data-testid="plan-shoot">
          <CheckIcon size={20} />
          <span className="start-tile-title">Plan my shoot</span>
          <span className="start-tile-sub">A shot list to film from</span>
        </Link>
        {librarySize > 0 ? (
          <button type="button" className="start-tile" disabled={busy} onClick={startFromLibrary} data-testid="start-from-library">
            <PanoIcon size={20} />
            <span className="start-tile-title">Starter library</span>
            <span className="start-tile-sub">360 rooms and songs</span>
          </button>
        ) : null}
        {/* Walk the block (ADR 0093): a drone clip of the land, the home drawn on it to scale. */}
        <Link href="/new/block" className="start-tile" prefetch={false} data-testid="walk-the-block">
          <PlanIcon size={20} />
          <span className="start-tile-title">Walk the block</span>
          <span className="start-tile-sub">A home drawn to scale on your land</span>
        </Link>
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
