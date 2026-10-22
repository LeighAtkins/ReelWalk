"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { defaultScheduleLocal, instagramAudioLabel, SCHEDULE_MAX_AHEAD_DAYS, toZonedLocal, type InstagramAudioChoice } from "@reelwalk/core";
import { schedulePost } from "@/app/scheduled-actions";
import { CalendarIcon } from "./icons";

const longTime = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Queues the export to post itself to Instagram later. The picker shows the
 * viewer's own time zone; the server converts and stores UTC. The caption is
 * the one in the box below, as saved when Schedule is tapped. With `story`
 * a story cut follows the reel (ADR 0065). The spacing guard answers once
 * with a warning when another post is within the hour; Schedule anyway
 * sends it again with the warning accepted.
 */
export function SchedulePost({
  jobId,
  username,
  audio = null,
  aiGenerated = false,
  story = false,
}: {
  jobId: string;
  username: string;
  audio?: InstagramAudioChoice | null;
  aiGenerated?: boolean;
  story?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [zone, setZone] = useState("UTC");
  const [local, setLocal] = useState("");
  const [bounds, setBounds] = useState<{ min: string; max: string } | null>(null);
  const [state, setState] = useState<
    | { step: "idle" | "saving" }
    | { step: "error"; error: string }
    | { step: "spacing"; warning: string }
    | { step: "done"; id: string; publishAt: Date; sound: string | null; storyId: string | null; storyError: string | null }
  >({ step: "idle" });

  // The zone is only known in the browser, so the defaults are set after hydration.
  useEffect(() => {
    if (!open || local) return;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const now = new Date();
    setZone(timeZone);
    setLocal(defaultScheduleLocal(now, timeZone));
    setBounds({
      min: toZonedLocal(new Date(now.getTime() + 5 * 60_000), timeZone),
      max: toZonedLocal(new Date(now.getTime() + SCHEDULE_MAX_AHEAD_DAYS * 86_400_000), timeZone),
    });
  }, [open, local]);

  async function submit(confirmSpacing: boolean) {
    setState({ step: "saving" });
    const result = await schedulePost({ jobId, local, timeZone: zone, audio, aiGenerated, story, confirmSpacing }).catch(() => ({ ok: false as const, error: "Could not reach ReelWalk. Try again." }));
    if (result.ok) {
      setState({ step: "done", id: result.id, publishAt: new Date(result.publishAt), sound: audio ? instagramAudioLabel(audio) : null, storyId: result.storyId, storyError: result.storyError });
    } else if ("spacing" in result && result.spacing) {
      setState({ step: "spacing", warning: result.error });
    } else {
      setState({ step: "error", error: result.error });
    }
  }

  if (state.step === "done") {
    return (
      <>
        <p className="schedule-done" role="status" style={{ gridColumn: "1 / -1" }} data-testid="schedule-confirmed" data-post-id={state.id} data-story-id={state.storyId ?? undefined}>
          Scheduled for {longTime.format(state.publishAt)} on @{username}
          {state.sound ? <> with the sound “{state.sound}”</> : null}
          {state.storyId ? <>, with a story right after</> : null}.{" "}
          <Link className="link" href="/scheduled" prefetch={false}>
            See scheduled posts
          </Link>
        </p>
        {state.storyError ? (
          <p className="error small" role="alert" style={{ gridColumn: "1 / -1", margin: 0 }}>
            {state.storyError}
          </p>
        ) : null}
      </>
    );
  }

  if (!open) {
    return (
      <button className="btn btn-quiet" type="button" onClick={() => setOpen(true)} data-testid="schedule-open">
        <CalendarIcon size={18} />
        Schedule
      </button>
    );
  }

  return (
    <form
      className="schedule-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(false);
      }}
      style={{ gridColumn: "1 / -1" }}
      data-testid="schedule-form"
    >
      <label className="field">
        <span>
          Post to @{username} on <span className="muted small">({zone.replace(/_/g, " ")} time)</span>
        </span>
        <input
          className="text-input"
          type="datetime-local"
          required
          value={local}
          min={bounds?.min}
          max={bounds?.max}
          onChange={(event) => {
            setLocal(event.target.value);
            if (state.step === "spacing") setState({ step: "idle" });
          }}
          data-testid="schedule-time"
        />
      </label>
      <p className="muted small" style={{ margin: 0 }}>
        Posts with the caption below{audio ? <> and the sound “{instagramAudioLabel(audio)}”</> : null}{aiGenerated ? <> and Instagram&apos;s AI info label</> : null}
        {story ? <>, then a story of its opening</> : null}. ReelWalk publishes it at that time, even with this screen closed.
      </p>
      {state.step === "spacing" ? (
        <p className="small" role="alert" style={{ margin: 0 }} data-testid="schedule-spacing">
          {state.warning}
        </p>
      ) : null}
      <div className="field-row">
        <button className="btn btn-quiet" type="button" onClick={() => setOpen(false)}>
          Not now
        </button>
        {state.step === "spacing" ? (
          <button className="btn btn-quiet" type="button" onClick={() => void submit(true)} data-testid="schedule-anyway">
            Schedule anyway
          </button>
        ) : (
          <button className="btn btn-signal" type="submit" disabled={!local || state.step === "saving"} data-testid="schedule-submit">
            {state.step === "saving" ? "Scheduling…" : "Schedule post"}
          </button>
        )}
      </div>
      {state.step === "error" ? (
        <p className="error small" role="alert" style={{ margin: 0 }}>
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
