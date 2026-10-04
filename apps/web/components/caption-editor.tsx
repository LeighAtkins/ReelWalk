"use client";

import { useEffect, useRef, useState } from "react";
import { countHashtags, INSTAGRAM } from "@reelwalk/core";
import { saveCaption } from "@/app/actions";
import { CopyIcon } from "./icons";

/** The Instagram post text, with Instagram's limits counted as you type. Saves itself. */
export function CaptionEditor({ reelId, initial, onChange }: { reelId: string; initial: string; onChange?(caption: string): void }) {
  const [caption, setCaption] = useState(initial);
  const [status, setStatus] = useState<"saved" | "saving" | "error">("saved");
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  function change(value: string) {
    setCaption(value);
    onChange?.(value);
    setStatus("saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const result = await saveCaption({ id: reelId, caption: value }).catch(() => ({ ok: false }));
      setStatus(result.ok ? "saved" : "error");
    }, 600);
  }

  const hashtags = countHashtags(caption);
  return (
    <div className="caption-box">
      <label className="field" htmlFor="caption">
        <span className="field-row">
          Post caption
          <span className="counter" data-over={caption.length > INSTAGRAM.captionMaxChars}>
            {caption.length}/{INSTAGRAM.captionMaxChars}
          </span>
        </span>
      </label>
      <textarea
        id="caption"
        className="text-area"
        rows={4}
        value={caption}
        placeholder="Write the text for your Instagram post. Add hashtags like #justlisted."
        onChange={(event) => change(event.target.value)}
      />
      <div className="field-row">
        <span className="counter" data-over={hashtags > INSTAGRAM.maxHashtags}>
          {hashtags}/{INSTAGRAM.maxHashtags} hashtags
          {status === "saving" ? ", saving…" : status === "error" ? ", not saved" : ""}
        </span>
        <button
          type="button"
          className="btn btn-quiet"
          disabled={!caption}
          onClick={async () => {
            await navigator.clipboard.writeText(caption);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          }}
        >
          <CopyIcon size={18} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
