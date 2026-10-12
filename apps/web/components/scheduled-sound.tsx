"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { InstagramAudioChoice } from "@reelwalk/core";
import { setScheduledSound } from "@/app/scheduled-actions";
import { InstagramSoundPicker } from "./instagram-sound-picker";

/** The "Sound" control on an upcoming post on /scheduled: change or remove its Instagram sound. */
export function ScheduledSound({ postId, initial }: { postId: string; initial: InstagramAudioChoice | null }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function change(next: InstagramAudioChoice | null) {
    const previous = value;
    setValue(next);
    setError(null);
    startTransition(async () => {
      const result = await setScheduledSound({ id: postId, audio: next }).catch(() => ({ ok: false as const, error: "Could not reach ReelWalk. Try again." }));
      if (!result.ok) {
        setValue(previous);
        setError(result.error);
      }
      router.refresh();
    });
  }

  return (
    <div className="scheduled-sound" data-testid="scheduled-sound" data-pending={pending || undefined}>
      <InstagramSoundPicker value={value} onChange={change} disabled={pending} compact />
      {error ? (
        <p className="error small" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
