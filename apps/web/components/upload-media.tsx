"use client";

import { useRef, useState } from "react";
import { confirmUpload, createUploadUrl } from "@/app/actions";

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

export function UploadMedia({ propertyId }: { propertyId: string }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    setProgress(0);

    try {
      setStatus("Preparing upload…");
      const ticket = await createUploadUrl({
        propertyId,
        fileName: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      });
      if (!ticket.ok) throw new Error(ticket.error);

      setStatus("Uploading…");
      await putWithProgress(ticket.url, file, ticket.contentType, setProgress);

      const confirmed = await confirmUpload({ propertyId, objectKey: ticket.objectKey, fileName: file.name });
      if (confirmed.error) throw new Error(confirmed.error);

      setStatus("Uploaded.");
      if (fileRef.current) fileRef.current.value = "";
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form">
      <input
        ref={fileRef}
        className="file"
        type="file"
        accept="video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp"
        disabled={busy}
        data-testid="media-file"
      />
      <button className="button" type="button" disabled={busy} onClick={upload}>
        Upload
      </button>
      {busy || progress > 0 ? (
        <div className="meter" aria-label="Upload progress">
          <span style={{ width: `${progress}%` }} />
        </div>
      ) : null}
      <div className="muted small" role="status" data-testid="upload-status">
        {status}
      </div>
    </div>
  );
}
