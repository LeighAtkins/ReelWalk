"use client";

import { useEffect, useState } from "react";
import { continueInstagramPost, startInstagramPost, type PostStep } from "@/app/instagram-actions";
import { InstagramIcon } from "./icons";

/**
 * One tap from a finished export to a published Reel, for workspaces with a
 * connected Instagram professional account. Instagram processes the video
 * for a few seconds to a few minutes; this polls until it is published.
 */
export function PostToInstagram({ jobId, username }: { jobId: string; username: string }) {
  const [step, setStep] = useState<PostStep | { state: "idle" } | { state: "starting" }>({ state: "idle" });

  useEffect(() => {
    if (step.state !== "processing") return;
    const id = step.containerId;
    const timer = setTimeout(async () => setStep(await continueInstagramPost({ containerId: id })), 5000);
    return () => clearTimeout(timer);
  }, [step]);

  async function post() {
    setStep({ state: "starting" });
    setStep(await startInstagramPost({ jobId }));
  }

  if (step.state === "published") {
    return (
      <p className="toast" role="status" style={{ gridColumn: "1 / -1" }} data-testid="instagram-published">
        Posted to @{username}.{" "}
        {step.permalink ? (
          <a className="link" href={step.permalink} target="_blank" rel="noopener">
            Open the Reel
          </a>
        ) : null}
      </p>
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
      {step.state === "failed" ? (
        <p className="error small" role="alert" style={{ gridColumn: "1 / -1" }}>
          {step.error}
        </p>
      ) : null}
    </>
  );
}
