import { useCallback, useEffect, useRef, useState } from "react";
import type { Timeline } from "@reelwalk/core";
import { saveReel } from "@/app/actions";

export type SaveStatus = "saved" | "unsaved" | "saving" | "error" | "conflict";

/**
 * Saves the timeline and title shortly after each change. Saves go out one at
 * a time, each carrying the revision the previous one returned; if another tab
 * saved in between, the server refuses and the editor asks for a reload.
 */
export function useAutosave(reelId: string, initialRevision: number, timeline: Timeline, title: string) {
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [message, setMessage] = useState<string | null>(null);
  const revision = useRef(initialRevision);
  const latest = useRef({ timeline, title });
  const saved = useRef({ timeline, title });
  const inFlight = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const blocked = useRef(false);

  const flush = useCallback(async (): Promise<boolean> => {
    clearTimeout(timer.current);
    while (inFlight.current) await inFlight.current;
    if (blocked.current) return false;
    const next = latest.current;
    if (next.timeline === saved.current.timeline && next.title === saved.current.title) return true;

    setStatus("saving");
    let ok = false;
    inFlight.current = (async () => {
      try {
        const result = await saveReel({ id: reelId, revision: revision.current, timeline: next.timeline, title: next.title });
        if (result.ok) {
          revision.current = result.revision;
          saved.current = next;
          ok = true;
          const pending = latest.current !== next;
          setStatus(pending ? "unsaved" : "saved");
          setMessage(null);
        } else {
          if (result.reason === "conflict" || result.reason === "missing") blocked.current = true;
          setStatus(result.reason === "conflict" || result.reason === "missing" ? "conflict" : "error");
          setMessage(result.message);
        }
      } catch {
        setStatus("error");
        setMessage("Could not save. Check your connection; changes are kept on this screen.");
      }
    })();
    await inFlight.current;
    inFlight.current = null;
    // Changes made while that save was running go out next.
    if (ok && (latest.current.timeline !== saved.current.timeline || latest.current.title !== saved.current.title)) {
      return flush();
    }
    return ok;
  }, [reelId]);

  useEffect(() => {
    latest.current = { timeline, title };
    if (timeline === saved.current.timeline && title === saved.current.title) return;
    if (blocked.current) return;
    setStatus("unsaved");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 700);
  }, [timeline, title, flush]);

  // Leaving the page or switching apps on a phone: save now, not in 700 ms.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [flush]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return { status, message, flush };
}
