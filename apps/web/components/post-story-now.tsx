"use client";

import { useEffect, useState } from "react";
import { continueInstagramPost, startInstagramStory, type PostStep } from "@/app/instagram-actions";
import { InstagramIcon } from "./icons";

/** What the export screen knows about posting this export as a Story (ADR 0065). */
export type StoryOptions = {
  /** How much of the opening the story cut keeps. */
  hookMs: number;
  /** The cut already made for this export, when there is one. */
  cut: { status: string } | null;
  /** Why the whole reel cannot be a story (too long for Instagram's 60 s), or null when it can. */
  fullIssue: string | null;
  /** The reel's length. */
  durationMs: number;
};

type Step = PostStep | { state: "idle" } | { state: "choosing" } | { state: "starting" };

/**
 * Posts a Story now from a finished export: its story cut (rendered first
 * when it is not yet, a minute or so), or the whole reel when it is no longer
 * than 60 s. Like a Reel post, the Story is a row the server publishes; this
 * only watches it.
 */
export function PostStoryNow({ jobId, username, aiGenerated, options }: { jobId: string; username: string; aiGenerated: boolean; options: StoryOptions }) {
  const [step, setStep] = useState<Step>({ state: "idle" });

  useEffect(() => {
    if (step.state !== "processing") return;
    const { postId } = step;
    const poll = setTimeout(async () => setStep(await continueInstagramPost({ postId }).catch((): PostStep => ({ state: "processing", postId }))), 5000);
    return () => clearTimeout(poll);
  }, [step]);

  async function post(source: "cut" | "full") {
    setStep({ state: "starting" });
    setStep(await startInstagramStory({ jobId, source, aiGenerated }).catch((): PostStep => ({ state: "failed", error: "Could not reach ReelWalk. Try again." })));
  }

  if (step.state === "published") {
    return (
      <p className="toast" role="status" style={{ gridColumn: "1 / -1" }} data-testid="instagram-story-published">
        Story posted to @{username}.
      </p>
    );
  }

  if (step.state === "choosing") {
    const seconds = Math.round(options.durationMs / 1000);
    return (
      <div className="schedule-form" style={{ gridColumn: "1 / -1" }} data-testid="story-choice">
        <p className="muted small" style={{ margin: 0 }}>
          Which video? Stories through the API carry no sticker, link, caption or sound.
        </p>
        <div className="field-row">
          <button className="btn btn-signal" type="button" onClick={() => void post("cut")} data-testid="story-post-cut">
            The story cut ({Math.round(options.hookMs / 1000)} s + plate){options.cut && options.cut.status !== "SUCCEEDED" ? ", rendering" : options.cut ? "" : ", renders first"}
          </button>
          <button className="btn btn-quiet" type="button" onClick={() => void post("full")} disabled={options.fullIssue !== null} title={options.fullIssue ?? undefined} data-testid="story-post-full">
            The whole reel ({seconds} s)
          </button>
          <button className="btn btn-quiet" type="button" onClick={() => setStep({ state: "idle" })}>
            Not now
          </button>
        </div>
        {options.fullIssue ? (
          <p className="muted small" style={{ margin: 0 }}>
            {options.fullIssue}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <button
        className="btn btn-quiet"
        type="button"
        onClick={() => setStep({ state: "choosing" })}
        disabled={step.state === "starting" || step.state === "processing"}
        data-testid="post-story-now"
      >
        <InstagramIcon size={18} />
        {step.state === "starting" ? "Sending…" : step.state === "processing" ? "Posting the story…" : "Post a Story now"}
      </button>
      {step.state === "processing" ? (
        <p className="muted small" style={{ gridColumn: "1 / -1", margin: 0 }} data-testid="instagram-story-processing">
          ReelWalk posts the story on its own once its video is ready. You can close this screen; it shows up under Scheduled posts.
        </p>
      ) : null}
      {step.state === "failed" ? (
        <p className="error small" role="alert" style={{ gridColumn: "1 / -1" }} data-testid="instagram-story-error">
          {step.error}
        </p>
      ) : null}
    </>
  );
}
