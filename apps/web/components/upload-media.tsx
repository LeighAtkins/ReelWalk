"use client";

import { useRef, useState } from "react";
import { confirmUpload, createUploadUrl } from "@/app/actions";
import { UploadIcon } from "./icons";

function putWithProgress(url: string, file: File, contentType: string, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () =>
      request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(`Storage rejected the upload (${request.status})`));
    request.onerror = () => reject(new Error("Upload failed"));
    request.open("PUT", url);
    // Must match the content type the URL was signed for.
    request.setRequestHeader("content-type", contentType);
    request.send(file);
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type Status = { text: string; tone: "info" | "done" | "error" };

export function UploadMedia({ propertyId }: { propertyId: string }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<{ name: string; size: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<Status>({ text: "", tone: "info" });
  const [busy, setBusy] = useState(false);

  function readChosen() {
    const file = fileRef.current?.files?.[0];
    setChosen(file ? { name: file.name, size: file.size } : null);
    setStatus({ text: "", tone: "info" });
  }

  function onDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (busy || !fileRef.current || event.dataTransfer.files.length === 0) return;
    fileRef.current.files = event.dataTransfer.files;
    readChosen();
  }

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setStatus({ text: "Choose a file first.", tone: "error" });
      return;
    }
    setBusy(true);
    setProgress(0);

    try {
      setStatus({ text: "Preparing upload…", tone: "info" });
      const ticket = await createUploadUrl({
        propertyId,
        fileName: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      });
      if (!ticket.ok) throw new Error(ticket.error);

      setStatus({ text: "Uploading…", tone: "info" });
      await putWithProgress(ticket.url, file, ticket.contentType, setProgress);

      const confirmed = await confirmUpload({ propertyId, objectKey: ticket.objectKey, fileName: file.name });
      if (confirmed.error) throw new Error(confirmed.error);

      setStatus({ text: "Uploaded.", tone: "done" });
      if (fileRef.current) fileRef.current.value = "";
      setChosen(null);
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : "Something went wrong", tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="upload">
      <label
        className="dropzone"
        data-dragging={dragging}
        data-busy={busy}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <UploadIcon />
        <strong>{chosen ? chosen.name : "Choose a photo or video"}</strong>
        <span className="muted small">{chosen ? formatSize(chosen.size) : "or drop it here. JPEG, PNG, WebP, MP4, MOV or WebM, up to 2 GB."}</span>
        <input
          ref={fileRef}
          type="file"
          accept="video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={readChosen}
          data-testid="media-file"
        />
      </label>

      {busy ? (
        <div className="meter" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <span style={{ width: `${progress}%` }} />
        </div>
      ) : null}

      <div className="upload-row">
        <button className="button" type="button" disabled={busy} onClick={upload}>
          Upload
        </button>
        <div className="upload-status" role="status" data-tone={status.tone} data-testid="upload-status">
          {status.text}
        </div>
      </div>
    </div>
  );
}
