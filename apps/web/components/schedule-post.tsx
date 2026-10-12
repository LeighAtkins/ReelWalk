"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { defaultScheduleLocal, SCHEDULE_MAX_AHEAD_DAYS, toZonedLocal } from "@reelwalk/core";
import { schedulePost } from "@/app/scheduled-actions";
import { CalendarIcon } from "./icons";

const longTime = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Queues the export to post itself to Instagram later. The picker shows the
 * viewer's own time zone; the server converts and stores UTC. The caption is
 * the one in the box below, as saved when Schedule is tapped.
 */
export function SchedulePost({ jobId, username }: { jobId: string; username: string }) {
  const [open, setOpen] = useState(false);
  const [zone, setZone] = useState("UTC");
  const [local, setLocal] = useState("");
  const [bounds, setBounds] = useState<{ min: string; max: string } | null>(null);
  const [state, setState] = useState<{ step: "idle" | "saving" } | { step: "error"; error: string } | { step: "done"; id: string; publishAt: Date }>({ step: "idle" });

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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState({ step: "saving" });
    const result = await schedulePost({ jobId, local, timeZone: zone }).catch(() => ({ ok: false as const, error: "Could not reach ReelWalk. Try again." }));
    setState(result.ok ? { step: "done", id: result.id, publishAt: new Date(result.publishAt) } : { step: "error", error: result.error });
  }

  if (state.step === "done") {
    return (
      <p className="schedule-done" role="status" style={{ gridColumn: "1 / -1" }} data-testid="schedule-confirmed" data-post-id={state.id}>
        Scheduled for {longTime.format(state.publishAt)} on @{username}.{" "}
        <Link className="link" href="/scheduled" prefetch={false}>
          See scheduled posts
        </Link>
      </p>
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
    <form className="schedule-form" onSubmit={submit} style={{ gridColumn: "1 / -1" }} data-testid="schedule-form">
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
          onChange={(event) => setLocal(event.target.value)}
          data-testid="schedule-time"
        />
      </label>
      <p className="muted small" style={{ margin: 0 }}>
        Posts with the caption below. ReelWalk publishes it at that time, even with this screen closed.
      </p>
      <div className="field-row">
        <button className="btn btn-quiet" type="button" onClick={() => setOpen(false)}>
          Not now
        </button>
        <button className="btn btn-signal" type="submit" disabled={!local || state.step === "saving"} data-testid="schedule-submit">
          {state.step === "saving" ? "Scheduling…" : "Schedule post"}
        </button>
      </div>
      {state.step === "error" ? (
        <p className="error small" role="alert" style={{ margin: 0 }}>
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
