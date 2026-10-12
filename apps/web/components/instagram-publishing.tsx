"use client";

import { useState } from "react";
import type { InstagramAudioChoice } from "@reelwalk/core";
import { InstagramSoundPicker } from "./instagram-sound-picker";
import { PostToInstagram } from "./post-to-instagram";
import { SchedulePost } from "./schedule-post";

/**
 * The export screen's Instagram actions: one "Instagram sound" choice shared
 * by Post now and Schedule, so whichever is tapped posts with that sound.
 * Rendered straight into the .export-actions grid. `live`: the deployment
 * can reach Instagram (or has the local stack's pretend one), so the sound
 * library and scheduling are offered.
 */
export function InstagramPublishing({ jobId, username, live }: { jobId: string; username: string; live: boolean }) {
  const [audio, setAudio] = useState<InstagramAudioChoice | null>(null);
  return (
    <>
      {live ? (
        <div style={{ gridColumn: "1 / -1" }}>
          <InstagramSoundPicker value={audio} onChange={setAudio} />
        </div>
      ) : null}
      <PostToInstagram jobId={jobId} username={username} audio={audio} />
      {live ? <SchedulePost jobId={jobId} username={username} audio={audio} /> : null}
    </>
  );
}
