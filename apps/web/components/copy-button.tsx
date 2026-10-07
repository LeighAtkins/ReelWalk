"use client";

import { useState } from "react";
import { copyText } from "@/lib/clipboard";
import { CheckIcon, CopyIcon } from "./icons";

/** Copies a string to the clipboard, with a short confirmation. */
export function CopyButton({
  text,
  label,
  copied = "Copied",
  className = "btn btn-quiet",
  testId,
}: {
  text: string;
  label: string;
  copied?: string;
  className?: string;
  testId?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={className}
      data-testid={testId}
      onClick={async () => {
        await copyText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1800);
      }}
    >
      {done ? <CheckIcon size={18} /> : <CopyIcon size={18} />}
      {done ? copied : label}
    </button>
  );
}
