"use client";

import { useState } from "react";
import { instagramAudioLabel, type InstagramAudioChoice } from "@reelwalk/core";
import { PlayWithSound } from "./export-sound";
import { InstagramSoundPicker } from "./instagram-sound-picker";
import { PostToInstagram } from "./post-to-instagram";
import { SchedulePost } from "./schedule-post";

/**
 * The export screen's Instagram actions: one "Instagram sound" choice shared
 * by Post now and Schedule, so whichever is tapped posts with that sound.
 * Rendered straight into the .export-actions grid. `live`: the deployment
 * can reach Instagram (or has the local stack's pretend one), so the sound
 * library and scheduling are offered.
 *
 * `reelSound` is the Instagram sound the reel was edited to (ADR 0019). It
 * starts out chosen, and can still be changed or removed.
 */
export function InstagramPublishing({
  jobId,
  username,
  live,
  reelSound = null,
  scheduledSound,
}: {
  jobId: string;
  username: string;
  live: boolean;
  reelSound?: InstagramAudioChoice | null;
  scheduledSound?: InstagramAudioChoice | null;
}) {
  const [audio, setAudio] = useState<InstagramAudioChoice | null>(scheduledSound === undefined ? reelSound : scheduledSound);
  return (
    <>
      {live ? (
        <div className="export-sound" style={{ gridColumn: "1 / -1" }}>
          <InstagramSoundPicker value={audio} onChange={setAudio} />
          {scheduledSound !== undefined ? (
            <p className="muted small" data-testid="scheduled-sound-note">
              {scheduledSound ? `Scheduled music: ${instagramAudioLabel(scheduledSound)}. Use Play with sound to hear the Instagram mix; the video controls and download play the original export.` : "This post is scheduled with its original export audio."}
              {" "}<a href="/scheduled">Change and save scheduled music</a>. Choices here do not update an existing scheduled post.
            </p>
          ) : reelSound ? (
            <p className="muted small" data-testid="reel-sound-note">
              {audio?.audioId === reelSound.audioId
                ? `You edited this reel to “${instagramAudioLabel(reelSound)}”. The video file has only your clips' own sound; Instagram adds this one when it posts.`
                : audio
                  ? `You edited this reel to “${instagramAudioLabel(reelSound)}”; the post will use the sound chosen above instead.`
                  : `You edited this reel to “${instagramAudioLabel(reelSound)}”. Without a sound the post goes out with only your clips' own sound.`}
            </p>
          ) : null}
          {audio ? <PlayWithSound sound={audio} /> : null}
        </div>
      ) : null}
      <PostToInstagram jobId={jobId} username={username} audio={audio} />
      {live ? <SchedulePost jobId={jobId} username={username} audio={audio} /> : null}
    </>
  );
}
