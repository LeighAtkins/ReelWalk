"use client";

import { useRef, useState } from "react";

type Job = {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  output_url?: string;
  error?: string;
};

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api";

function uploadWithProgress(url: string, file: File, onProgress: (progress: number) => void): Promise<Response> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    const request = new XMLHttpRequest();
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () =>
      resolve(
        new Response(request.responseText, {
          status: request.status,
          statusText: request.statusText,
          headers: { "content-type": request.getResponseHeader("content-type") ?? "application/json" },
        }),
      );
    request.onerror = () => reject(new Error("Upload failed"));
    request.open("POST", url);
    request.send(form);
  });
}

async function pollJob(listingId: string, onJob: (job: Job) => void) {
  for (;;) {
    const response = await fetch(`${apiBase}/listings/${listingId}/jobs/last`);
    if (response.ok) {
      const job = (await response.json()) as Job;
      onJob(job);
      if (job.status === "done" || job.status === "failed") return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 1800));
  }
}

export default function Home() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Choose a walkthrough video or a 360\u00b0 panorama image.");
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<Job | null>(null);

  async function submit() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    setProgress(0);
    setJob(null);

    try {
      setStatus("Creating listing...");
      const listingResponse = await fetch(`${apiBase}/listings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: file.name.replace(/\.[a-z0-9]+$/i, "") }),
      });
      if (!listingResponse.ok) throw new Error("Could not create listing");
      const listing = await listingResponse.json();

      setStatus("Uploading video...");
      const uploadResponse = await uploadWithProgress(`${apiBase}/listings/${listing.id}/upload`, file, setProgress);
      if (!uploadResponse.ok) throw new Error(await uploadResponse.text());

      setStatus("Rendering stub reel...");
      await pollJob(listing.id, (nextJob) => {
        setJob(nextJob);
        setStatus(nextJob.status === "done" ? "Render complete." : `Render ${nextJob.status}...`);
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <section className="panel">
        <h1>New listing</h1>
        <p>Upload a walkthrough video (MP4/MOV) or a panorama image (JPG/PNG) and ReelWalk will run the stub render pipeline.</p>
        <div className="uploadBox">
          <input ref={fileRef} className="file" type="file" accept="video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp" disabled={busy} />
          <button className="button" type="button" disabled={busy} onClick={submit}>
            Upload and render
          </button>
          <div className="meter" aria-label="Upload progress">
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className="status">{status}</div>
        </div>
      </section>
      <section className="preview">
        <div className="phone">
          {job?.status === "done" && job.output_url ? (
            <video src={job.output_url} controls playsInline />
          ) : (
            <div className="placeholder">Rendered 9:16 stub reel appears here.</div>
          )}
        </div>
      </section>
    </main>
  );
}
