"use client";

import { useEffect, useRef, useState } from "react";

/** Records the learner's answer with the microphone and plays it back. Nothing is uploaded. */
export function Recorder({ resetKey }: { resetKey: string }) {
  const [state, setState] = useState<"idle" | "recording" | "denied" | "unsupported">("idle");
  const [url, setUrl] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && !("MediaRecorder" in window)) setState("unsupported");
  }, []);

  useEffect(() => {
    setUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    rec.current?.stop();
    setSeconds(0);
  }, [resetKey]);

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const r = new MediaRecorder(stream);
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timer.current) clearInterval(timer.current);
        const blob = new Blob(chunks, { type: r.mimeType || "audio/webm" });
        setUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(blob);
        });
        setState("idle");
      };
      rec.current = r;
      r.start();
      setSeconds(0);
      timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
      setState("recording");
    } catch {
      setState("denied");
    }
  }

  if (state === "unsupported") return <p className="note">This browser can't record audio.</p>;

  return (
    <div className="rec">
      {state === "recording" ? (
        <button type="button" className="btn" data-on onClick={() => rec.current?.stop()}>
          ● Stop recording <span className="timer">{seconds}s</span>
        </button>
      ) : (
        <button type="button" className="btn" onClick={start}>
          ● {url ? "Record again" : "Record my answer"}
        </button>
      )}
      {state === "denied" && <p className="note">Microphone access was blocked. Allow it in the browser's site settings to record.</p>}
      {url && state !== "recording" && <audio controls src={url} />}
    </div>
  );
}
