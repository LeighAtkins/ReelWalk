"use client";

import { useState, useTransition } from "react";
import { setShareLink } from "@/app/actions";
import { copyText } from "@/lib/clipboard";
import { CheckIcon, LinkIcon } from "./icons";

/**
 * A link anyone can open: the video, the caption and a Save button, no
 * sign-in. Works from every phone and messenger, including where the share
 * sheet cannot attach a file (plain HTTP). The owner can switch it off.
 */
export function ShareLink({ reelId, initialUrl }: { reelId: string; initialUrl: string | null }) {
  const [url, setUrl] = useState(initialUrl);
  const [state, setState] = useState<"idle" | "copied" | "shared">("idle");
  const [pending, start] = useTransition();

  async function share(link: string) {
    if (navigator.share) {
      try {
        await navigator.share({ url: link });
        setState("shared");
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    await copyText(link);
    setState("copied");
    setTimeout(() => setState("idle"), 2000);
  }

  function enable() {
    start(async () => {
      const result = await setShareLink({ id: reelId, enabled: true });
      if (result.url) {
        setUrl(result.url);
        await share(result.url);
      }
    });
  }

  function disable() {
    start(async () => {
      await setShareLink({ id: reelId, enabled: false });
      setUrl(null);
      setState("idle");
    });
  }

  if (!url) {
    return (
      <button className="btn btn-quiet" type="button" onClick={enable} disabled={pending} data-testid="share-link">
        <LinkIcon size={18} />
        {pending ? "Making link…" : "Share a link"}
      </button>
    );
  }

  return (
    <div className="share-link" data-testid="share-link-box">
      <button className="btn btn-quiet" type="button" onClick={() => share(url)} data-testid="copy-share-link">
        {state === "copied" ? <CheckIcon size={18} /> : <LinkIcon size={18} />}
        {state === "copied" ? "Link copied" : state === "shared" ? "Link shared" : "Share the link"}
      </button>
      <a className="share-link-url small" href={url} target="_blank" rel="noopener" data-testid="share-link-url">
        {url.replace(/^https?:\/\//, "")}
      </a>
      <button className="btn btn-quiet small" type="button" onClick={disable} disabled={pending}>
        Turn link off
      </button>
    </div>
  );
}
