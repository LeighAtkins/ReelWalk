"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { acceptFor } from "@reelwalk/core";
import { createReel } from "@/app/actions";
import { setPendingFiles } from "@/lib/pending-files";
import { PlusIcon } from "./icons";

/**
 * The way Instagram starts a reel: pick photos and videos first, then edit.
 * The editor opens straight away and uploads the files there, with progress
 * on the timeline.
 */
export function NewReelPicker() {
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

  return (
    <div>
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
      {error ? <p className="error small" role="alert">{error}</p> : null}
    </div>
  );
}
