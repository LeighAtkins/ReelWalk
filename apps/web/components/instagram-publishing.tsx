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
 *
 * `aiContent`: the reel uses AI-generated clips, so the "AI info" label starts
 * ticked. Instagram asks for that disclosure; the studio can still untick it.
 */
export function InstagramPublishing({
  jobId,
  username,
  live,
  reelSound = null,
  scheduledSound,
  aiContent = false,
}: {
  jobId: string;
  username: string;
  live: boolean;
  reelSound?: InstagramAudioChoice | null;
  scheduledSound?: InstagramAudioChoice | null;
  aiContent?: boolean;
}) {
  const [audio, setAudio] = useState<InstagramAudioChoice | null>(scheduledSound === undefined ? reelSound : scheduledSound);
  const [aiGenerated, setAiGenerated] = useState(aiContent);
  return (
    <>
      {live ? (
        <label className="field" style={{ gridColumn: "1 / -1" }} data-testid="ai-label">
          <span>
            <input type="checkbox" checked={aiGenerated} onChange={(event) => setAiGenerated(event.target.checked)} /> Label this post as AI-generated on Instagram
          </span>
          <span className="muted small">{aiContent ? "This reel uses AI-generated clips, so Instagram's AI info label is on. " : ""}Instagram shows a small “AI info” note on the post; your caption is unchanged.</span>
        </label>
      ) : null}
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
      <PostToInstagram jobId={jobId} username={username} audio={audio} aiGenerated={aiGenerated} />
      {live ? <SchedulePost jobId={jobId} username={username} audio={audio} aiGenerated={aiGenerated} /> : null}
    </>
  );
}
