"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PROPERTY_TYPES, ROOM_NAMES, SHOT_MOVE_LABELS, acceptFor, matchUploadsToShots, type PropertyType, type Shot } from "@reelwalk/core";
import { createReel } from "@/app/actions";
import { makeShotList } from "@/app/shoot-actions";
import { setPendingFiles } from "@/lib/pending-files";
import { CheckIcon, PlusIcon, SparkIcon } from "./icons";

/** Saved on the phone, so a shot list survives the camera app, a reload or a dropped signal mid-shoot. */
const STORAGE_KEY = "reelwalk:shoot-plan";

type Plan = { shots: Shot[]; note: string; source: "ai" | "standard"; why?: string; ticked: boolean[] };

const PICKABLE_ROOMS = ROOM_NAMES.filter((room) => room !== "exterior" && room !== "front door");
const STARTING_ROOMS = ["living room", "kitchen", "primary bedroom", "bathroom"];

/**
 * "Plan my shoot" (ADR 0063): the property and its rooms in, an ordered shot
 * list out, ticked off while filming. Then the clips are picked and put in
 * the order they were filmed, each one knowing its room, and the editor
 * opens as from New reel or Make it for me.
 */
export function ShootPlanner() {
  const router = useRouter();
  const [propertyType, setPropertyType] = useState<PropertyType>("house");
  const [rooms, setRooms] = useState<string[]>(STARTING_ROOMS);
  const [listing, setListing] = useState("");
  const [showListing, setShowListing] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<"plan" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const restored = useRef(false);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Plan | null;
      if (saved?.shots?.length) setPlan(saved);
    } catch {
      // A damaged save is a fresh start.
    }
  }, []);

  function keep(next: Plan | null) {
    setPlan(next);
    try {
      if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private browsing: the list still works for this visit.
    }
  }

  async function makeList() {
    setBusy("plan");
    setError(null);
    const result = await makeShotList({ propertyType, rooms, listing: showListing ? listing : "" }).catch(() => ({ ok: false as const, message: "Could not make the list. Check your connection and try again." }));
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    keep({ shots: result.list.shots, note: result.list.note, source: result.list.source, why: result.list.why, ticked: result.list.shots.map(() => false) });
  }

  async function start(files: File[], autopilot: boolean) {
    if (!plan || files.length === 0) return;
    setBusy("start");
    setError(null);
    try {
      // Matched by the order they were filmed in: the n-th clip is the n-th ticked shot.
      const matched = matchUploadsToShots(files, plan.shots, plan.ticked);
      const { id } = await createReel();
      setPendingFiles(id, matched.map((match) => files[match.file]), matched.map((match) => match.room));
      router.push(autopilot ? `/reels/${id}?auto=1` : `/reels/${id}`);
    } catch {
      setError("Could not start a reel. Check your connection and try again.");
      setBusy(null);
    }
  }

  if (!plan) {
    return (
      <section className="shoot" aria-label="Plan my shoot">
        <div className="field">
          <span>What are you filming?</span>
          <div className="choice-row choice-wrap" role="group" aria-label="Property type">
            {PROPERTY_TYPES.map((type) => (
              <button key={type} type="button" className="choice" aria-pressed={propertyType === type} onClick={() => setPropertyType(type)}>
                {type.charAt(0).toUpperCase() + type.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span>Rooms you will film</span>
          <div className="choice-row choice-wrap" role="group" aria-label="Rooms" data-testid="shoot-rooms">
            {PICKABLE_ROOMS.map((room) => {
              const on = rooms.includes(room);
              return (
                <button key={room} type="button" className="choice" aria-pressed={on} onClick={() => setRooms(on ? rooms.filter((r) => r !== room) : [...rooms, room])}>
                  {room.charAt(0).toUpperCase() + room.slice(1)}
                </button>
              );
            })}
          </div>
        </div>
        {showListing ? (
          <label className="field">
            The listing (optional)
            <textarea className="text-input" rows={5} maxLength={1500} value={listing} onChange={(event) => setListing(event.target.value)} placeholder="Paste the listing description: the rooms and features it mentions are planned for." />
          </label>
        ) : (
          <button type="button" className="btn btn-quiet btn-block" onClick={() => setShowListing(true)}>
            Paste the listing instead
          </button>
        )}
        <button type="button" className="btn btn-signal btn-block" disabled={busy !== null || (rooms.length === 0 && listing.trim().length < 20)} onClick={makeList} data-testid="make-shot-list">
          {busy === "plan" ? "Planning…" : "Make my shot list"}
        </button>
        {error ? <p className="error small" role="alert">{error}</p> : null}
      </section>
    );
  }

  const done = plan.ticked.filter(Boolean).length;
  return (
    <section className="shoot" aria-label="Shot list">
      <p className="muted small" data-testid="shot-list-source">
        {plan.source === "ai" ? plan.note || "Film in this order and tick each shot as you go." : plan.why ?? plan.note}
      </p>
      <p className="small timecode" role="status">
        {done} of {plan.shots.length} filmed
      </p>
      <ol className="shot-list" data-testid="shot-list">
        {plan.shots.map((shot, index) => (
          <li key={`${shot.room}-${index}`}>
            <label className="shot" data-done={plan.ticked[index] || undefined}>
              <input
                type="checkbox"
                checked={plan.ticked[index] ?? false}
                onChange={(event) => keep({ ...plan, ticked: plan.ticked.map((value, at) => (at === index ? event.target.checked : value)) })}
              />
              <span className="shot-box" aria-hidden="true">
                <CheckIcon size={16} />
              </span>
              <span className="shot-text">
                <span className="shot-title">
                  {index + 1}. {shot.title}
                  <span className="muted small"> · {SHOT_MOVE_LABELS[shot.move]}, hold {shot.holdS} s</span>
                </span>
                <span className="small">{shot.how}</span>
              </span>
            </label>
          </li>
        ))}
      </ol>

      <p className="muted small" data-testid="shoot-matching-note">
        When you are done, pick the clips. They go in the order you filmed them, and each is named after the {done > 0 ? "ticked shot" : "shot"} filmed at that point. Rooms are guessed from the filming order: a skipped or extra clip shifts the ones after it, so check the room names in the editor.
      </p>
      <label className="start-primary start-auto" data-busy={busy === "start"}>
        <span className="viewfinder" aria-hidden="true">
          <SparkIcon size={22} />
        </span>
        <span className="start-text">
          <span className="start-title">{busy === "start" ? "Opening…" : "Make it for me"}</span>
          <span className="start-sub">Pick the clips; ReelWalk cuts them to music in this order.</span>
        </span>
        <input type="file" multiple accept={acceptFor(["IMAGE", "VIDEO"])} disabled={busy !== null} aria-label="Make it for me with the filmed clips" onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void start(files, true);
        }} />
      </label>
      <label className="start-primary start-manual" data-busy={busy === "start"}>
        <span className="viewfinder" aria-hidden="true">
          <PlusIcon size={22} />
        </span>
        <span className="start-text">
          <span className="start-title">Edit them myself</span>
          <span className="start-sub">The clips open in the editor in shot order.</span>
        </span>
        <input type="file" multiple accept={acceptFor(["IMAGE", "VIDEO"])} disabled={busy !== null} aria-label="Edit the filmed clips myself" data-testid="shoot-clips-input" onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void start(files, false);
        }} />
      </label>
      <button type="button" className="btn btn-quiet btn-block" disabled={busy !== null} onClick={() => keep(null)}>
        Plan another shoot
      </button>
      {error ? <p className="error small" role="alert">{error}</p> : null}
    </section>
  );
}
