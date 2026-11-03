import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRange, RENDER_PAGE_PORT, serveBundle } from "../src/bundle-server";

describe("the render page's origin (ADR 0107)", () => {
  it("is one the media bucket's CORS allows", async () => {
    const variables = await readFile(fileURLToPath(new URL("../../../infra/terraform/variables.tf", import.meta.url)), "utf8");
    const origins = /variable "media_cors_origins"[\s\S]*?default\s*=\s*\[([^\]]*)\]/.exec(variables)?.[1] ?? "";
    expect(origins).toContain(`"http://localhost:${RENDER_PAGE_PORT}"`);
  });
});

describe("parseRange", () => {
  it("reads a single byte range", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("bytes=0-0", 100)).toEqual({ start: 0, end: 0 });
    expect(parseRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
  });

  it("answers the whole file for what it does not read, and 416 past the end", () => {
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=5-2", 100)).toBe("unsatisfiable");
  });
});

describe("serveBundle", () => {
  let root: string;
  let server: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "reelwalk-bundle-"));
    root = path.join(dir, "bundle");
    await mkdir(path.join(root, "public", "sfx"), { recursive: true });
    await writeFile(path.join(root, "index.html"), "<!doctype html>");
    await writeFile(path.join(root, "bundle.js"), "console.log(1)");
    await writeFile(path.join(root, "public", "sfx", "tick.wav"), Buffer.from("0123456789"));
    await writeFile(path.join(dir, "secret.txt"), "outside");
    server = await serveBundle(root, 0);
  });

  afterAll(async () => {
    await server.close();
    await rm(path.dirname(root), { recursive: true, force: true });
  });

  it("names itself on localhost, as Remotion's own server does", () => {
    expect(server.url).toMatch(/^http:\/\/localhost:\d+$/);
  });

  it("serves the bundle's files with their types, a directory as its index", async () => {
    const index = await fetch(`${server.url}/index.html`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${server.url}/`)).status).toBe(200);
    const script = await fetch(`${server.url}/bundle.js?v=1`);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(await script.text()).toBe("console.log(1)");
  });

  it("answers byte ranges and HEAD", async () => {
    const part = await fetch(`${server.url}/public/sfx/tick.wav`, { headers: { range: "bytes=2-4" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(await part.text()).toBe("234");
    const head = await fetch(`${server.url}/public/sfx/tick.wav`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");
    expect((await fetch(`${server.url}/public/sfx/tick.wav`, { headers: { range: "bytes=10-" } })).status).toBe(416);
  });

  it("serves nothing outside the bundle and nothing it does not have", async () => {
    expect((await fetch(`${server.url}/..%2Fsecret.txt`)).status).toBe(404);
    expect((await fetch(`${server.url}/%2e%2e/secret.txt`)).status).toBe(404);
    expect((await fetch(`${server.url}/missing.js`)).status).toBe(404);
    expect((await fetch(`${server.url}/index.html`, { method: "POST" })).status).toBe(405);
  });

  it("refuses a port that is taken", async () => {
    const port = Number(new URL(server.url).port);
    await expect(serveBundle(root, port)).rejects.toThrow(/EADDRINUSE/);
  });
});
