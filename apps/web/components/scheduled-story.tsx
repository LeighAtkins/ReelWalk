"use client";

import { useState } from "react";
import { setScheduledStory } from "@/app/scheduled-actions";

/**
 * "Also post a Story" on a waiting reel post (ADR 0065): ticking it renders
 * the story cut now and queues a Story right after the reel; unticking drops
 * the waiting Story. A reel already going out cannot change.
 */
export function ScheduledStory({ postId, initial }: { postId: string; initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    const result = await setScheduledStory({ id: postId, story: next }).catch(() => ({ ok: false as const, error: "Could not reach ReelWalk. Try again." }));
    if (result.ok) setOn(next);
    else setError(result.error);
    setBusy(false);
  }

  return (
    <label className="small" data-testid="scheduled-story-toggle" data-on={on ? "1" : "0"}>
      <input type="checkbox" checked={on} disabled={busy} onChange={(event) => void toggle(event.target.checked)} /> Also post a Story right after
      {error ? (
        <span className="error small" role="alert" style={{ display: "block" }}>
          {error}
        </span>
      ) : null}
    </label>
  );
}
