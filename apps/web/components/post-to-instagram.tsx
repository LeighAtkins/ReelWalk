"use client";

import { useEffect, useState } from "react";
import type { InstagramAudioChoice } from "@reelwalk/core";
import { continueInstagramPost, startInstagramPost, type PostStep } from "@/app/instagram-actions";
import { InstagramIcon } from "./icons";

type Step = PostStep | { state: "idle" } | { state: "starting" };

/**
 * One tap from a finished export to a published Reel, for workspaces with a
 * connected Instagram professional account. The post is a row the server
 * publishes (ADR 0065); this screen only watches it, every few seconds,
 * and can be closed at any point without losing the post. With `story`, a
 * story cut goes out as a Story right after the Reel.
 */
export function PostToInstagram({
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
  const [step, setStep] = useState<Step>({ state: "idle" });
  const [storyStep, setStoryStep] = useState<PostStep | null>(null);
  const storyPostId = step.state === "processing" || step.state === "published" ? step.storyPostId : undefined;

  useEffect(() => {
    if (step.state !== "processing") return;
    const { postId, storyPostId: storyId, storyError } = step;
    const poll = setTimeout(async () => {
      const next = await continueInstagramPost({ postId }).catch((): PostStep => ({ state: "processing", postId }));
      // The story's id was known at the start; the poll does not repeat it.
      setStep(next.state === "failed" ? next : { ...next, storyPostId: storyId, storyError });
    }, 5000);
    return () => clearTimeout(poll);
  }, [step]);

  // Once the Reel is out, follow the Story the same way.
  useEffect(() => {
    if (step.state !== "published" || !storyPostId) return;
    if (storyStep && storyStep.state !== "processing") return;
    const poll = setTimeout(async () => setStoryStep(await continueInstagramPost({ postId: storyPostId }).catch((): PostStep => ({ state: "processing", postId: storyPostId }))), storyStep ? 5000 : 0);
    return () => clearTimeout(poll);
  }, [step.state, storyPostId, storyStep]);

  async function post() {
    setStep({ state: "starting" });
    setStoryStep(null);
    setStep(await startInstagramPost({ jobId, audio, aiGenerated, story }).catch((): PostStep => ({ state: "failed", error: "Could not reach ReelWalk. Try again." })));
  }

  if (step.state === "published") {
    return (
      <>
        <p className="toast" role="status" style={{ gridColumn: "1 / -1" }} data-testid="instagram-published">
          Posted to @{username}.{" "}
          {step.permalink ? (
            <a className="link" href={step.permalink} target="_blank" rel="noopener">
              Open the Reel
            </a>
          ) : null}
        </p>
        {storyPostId ? (
          storyStep?.state === "published" ? (
            <p className="toast" role="status" style={{ gridColumn: "1 / -1" }} data-testid="instagram-story-published">
              Story posted to @{username}.
            </p>
          ) : storyStep?.state === "failed" ? (
            <p className="error small" role="alert" style={{ gridColumn: "1 / -1" }} data-testid="instagram-story-error">
              The story was not posted: {storyStep.error}
            </p>
          ) : (
            <p className="muted small" role="status" style={{ gridColumn: "1 / -1" }} data-testid="instagram-story-processing">
              Posting the story next… You can leave this screen; it goes out on its own.
            </p>
          )
        ) : null}
        {step.storyError ? (
          <p className="error small" role="alert" style={{ gridColumn: "1 / -1" }}>
            {step.storyError}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <>
      <button
        className="btn btn-signal"
        type="button"
        onClick={post}
        disabled={step.state === "starting" || step.state === "processing"}
        data-testid="post-to-instagram"
      >
        <InstagramIcon size={18} />
        {step.state === "starting" ? "Sending…" : step.state === "processing" ? "Instagram is processing…" : `Post to @${username}`}
      </button>
      {step.state === "processing" ? (
        <p className="muted small" style={{ gridColumn: "1 / -1", margin: 0 }} data-testid="instagram-processing">
          ReelWalk is posting this on its own{story ? ", then the story" : ""}. You can close this screen; it shows up under Scheduled posts.
        </p>
      ) : null}
      {step.state === "failed" ? (
        <p className="error small" role="alert" style={{ gridColumn: "1 / -1" }}>
          {step.error}
        </p>
      ) : null}
    </>
  );
}
