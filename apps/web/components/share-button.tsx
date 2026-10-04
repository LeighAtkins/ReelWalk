"use client";

import { useState } from "react";
import { copyText } from "@/lib/clipboard";
import { ShareIcon } from "./icons";

/**
 * Opens the phone's share sheet with the MP4 attached, where Instagram is one
 * of the targets. Instagram ignores text sent along with a video, so the
 * caption is copied to the clipboard first, ready to paste.
 */
export function ShareButton({ url, fileName, caption }: { url: string; fileName: string; caption: string }) {
  const [state, setState] = useState<"idle" | "busy" | "copied" | "unsupported" | "error">("idle");

  async function share() {
    setState("busy");
    try {
      if (caption) await copyText(caption);
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], fileName.replace(/[^\w.\- ]+/g, "") || "reel.mp4", { type: "video/mp4" });
      if (!navigator.canShare?.({ files: [file] })) {
        setState("unsupported");
        return;
      }
      await navigator.share({ files: [file] });
      setState(caption ? "copied" : "idle");
    } catch (error) {
      // Closing the share sheet is not an error.
      setState(error instanceof DOMException && error.name === "AbortError" ? "idle" : "error");
    }
  }

  return (
    <>
      <button className="btn btn-signal" type="button" onClick={share} disabled={state === "busy"}>
        <ShareIcon size={18} />
        {state === "busy" ? "Preparing video…" : "Share to Instagram"}
      </button>
      {state === "copied" ? <p className="toast" role="status">Caption copied. Paste it in Instagram.</p> : null}
      {state === "unsupported" ? (
        <p className="muted small" role="status" style={{ gridColumn: "1 / -1" }}>
          This browser cannot share files here (sharing needs HTTPS). Download the video and post it from your
          phone&apos;s gallery.
        </p>
      ) : null}
      {state === "error" ? (
        <p className="error small" role="alert" style={{ gridColumn: "1 / -1" }}>
          Could not open the share sheet. Download the video instead.
        </p>
      ) : null}
    </>
  );
}
