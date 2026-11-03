/**
 * The render page's one origin (ADR 0107). Given a bundle directory, Remotion
 * starts an HTTP server for every selectComposition, renderStill and
 * renderMedia call, each on the first free port from 3000, so preflight's
 * three stills at once ran on http://localhost:3000, :3001 and :3002. The
 * person matte reads its footage with `crossOrigin = "anonymous"` (to read the
 * pixels back), and the media bucket answers CORS for http://localhost:3000
 * only: a matte drawn on :3001 or :3002 failed with `video error 4`.
 *
 * So the worker serves the bundle itself, once per process, on
 * RENDER_PAGE_PORT, and hands Remotion that URL: every page then has the same
 * origin, the one the bucket's and CloudFront's CORS already allow
 * (`media_cors_origins` in infra/terraform/variables.tf). Remotion still starts
 * its own video proxy per call; only the page moves.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

/** Must stay in `media_cors_origins` as http://localhost:<port>. */
export const RENDER_PAGE_PORT = 3000;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export function contentType(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** A single `bytes=` range of a file of `size` bytes: the bytes to send, null for the whole file, "unsatisfiable" for a 416. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Several ranges, or another unit: the whole file, as a server may answer.
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start: number, end: number;
  if (match[1] === "") {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/** Serves the files under `root` (GET and HEAD), a directory as its index.html; nothing outside it. */
export function bundleHandler(root: string): http.RequestListener {
  const base = path.resolve(root);
  return async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    let file: string;
    try {
      file = path.resolve(base, "." + decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname));
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (file !== base && !file.startsWith(base + path.sep)) {
      response.writeHead(404).end();
      return;
    }
    try {
      let info = await stat(file);
      if (info.isDirectory()) {
        file = path.join(file, "index.html");
        info = await stat(file);
      }
      if (!info.isFile()) throw new Error("not a file");
      const range = parseRange(request.headers.range, info.size);
      const headers: http.OutgoingHttpHeaders = { "content-type": contentType(file), "accept-ranges": "bytes", "cache-control": "no-cache" };
      if (range === "unsatisfiable") {
        response.writeHead(416, { ...headers, "content-range": `bytes */${info.size}` }).end();
        return;
      }
      const { start, end } = range ?? { start: 0, end: info.size - 1 };
      response.writeHead(range ? 206 : 200, {
        ...headers,
        "content-length": Math.max(0, end - start + 1),
        ...(range ? { "content-range": `bytes ${start}-${end}/${info.size}` } : {}),
      });
      if (request.method === "HEAD" || info.size === 0) {
        response.end();
        return;
      }
      createReadStream(file, { start, end }).on("error", () => response.destroy()).pipe(response);
    } catch {
      if (!response.headersSent) response.writeHead(404).end();
    }
  };
}

/**
 * Serves `root` on 127.0.0.1:`port` and returns its URL, http://localhost:<port> as Remotion's own server names it.
 * The server does not keep the process alive. Rejects when the port is taken.
 */
export function serveBundle(root: string, port: number = RENDER_PAGE_PORT): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(bundleHandler(root));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host: "127.0.0.1" }, () => {
      server.off("error", reject);
      server.unref();
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      resolve({
        url: `http://localhost:${bound}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
