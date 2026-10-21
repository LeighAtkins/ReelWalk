#!/usr/bin/env node
/* global console, process, fetch, WebSocket, atob, setTimeout, Buffer */
/**
 * Seed a workspace's presenter kit (ADR 0056) from two local stills, through
 * a signed-in browser tab: the photos go up through the app's own upload API
 * (/api/uploads → PUT to storage → /api/uploads/confirm) as the workspace's
 * own uploads, then /api/presenters creates the kit. Nothing here holds a
 * credential: the tab's session does the work, and the photos never enter
 * the repository.
 *
 *   node apps/worker/scripts/seed-presenter.mjs \
 *     --portrait "<head-and-shoulders still>" --full-body "<full-length still>" \
 *     [--name Maya] [--origin https://reelwalking.com] [--cdp http://127.0.0.1:9333] [--not-default] [--dry-run]
 *
 * Needs a Chrome started with --remote-debugging-port (the agent Chrome on
 * 9333) with a tab open on --origin and signed in to the workspace. --dry-run
 * checks the photos and prints the plan without connecting to Chrome.
 * Uses Node's built-in fetch and WebSocket (Node 22+); no dependencies.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = { name: "Maya", origin: "https://reelwalking.com", cdp: "http://127.0.0.1:9333", isDefault: true, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], next = () => { const value = argv[++i]; if (!value) throw new Error(`${flag} needs a value.`); return value; };
    if (flag === "--portrait") args.portrait = next();
    else if (flag === "--full-body") args.fullBody = next();
    else if (flag === "--name") args.name = next();
    else if (flag === "--origin") args.origin = next().replace(/\/$/, "");
    else if (flag === "--cdp") args.cdp = next().replace(/\/$/, "");
    else if (flag === "--not-default") args.isDefault = false;
    else if (flag === "--dry-run") args.dryRun = true;
    else throw new Error(`Unknown option ${flag}.`);
  }
  if (!args.portrait || !args.fullBody) throw new Error("Give --portrait and --full-body.");
  return args;
}

/** Type and size of a JPEG or PNG from its bytes. */
function still(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) { at++; continue; }
      const marker = bytes[at + 1], length = bytes.readUInt16BE(at + 2);
      // Start-of-frame markers carry the size; DHT (C4), JPG (C8) and DAC (CC) share the range but do not.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { contentType: "image/jpeg", height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
      }
      at += 2 + length;
    }
  }
  throw new Error("Not a JPEG or PNG.");
}

async function load(file) {
  const bytes = await readFile(file);
  if (bytes.length > 20 * 1024 * 1024) throw new Error(`${file} is over 20 MB.`);
  return { file, fileName: path.basename(file), bytes, ...still(bytes) };
}

/** Runs in the signed-in tab: upload each still through the app's upload API, then create the kit. */
async function inTab({ stills, name, isDefault }) {
  const post = async (url, body) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(`${url}: ${data.error ?? response.status}`);
    return data;
  };
  const ids = [];
  for (const item of stills) {
    const bytes = Uint8Array.from(atob(item.base64), c => c.charCodeAt(0));
    const ticket = await post("/api/uploads", { fileName: item.fileName, contentType: item.contentType, sizeBytes: bytes.length, withThumbnail: false });
    if (!ticket.uploadUrl) throw new Error("The upload API asked for a multipart upload; use a smaller still.");
    const put = await fetch(ticket.uploadUrl, { method: "PUT", headers: { "content-type": ticket.contentType }, body: bytes });
    if (!put.ok) throw new Error(`Storage refused the upload (${put.status}).`);
    const confirmed = await post("/api/uploads/confirm", { objectKey: ticket.objectKey, thumbKey: null, fileName: item.fileName, durationMs: null, width: item.width, height: item.height });
    ids.push(confirmed.asset.id);
  }
  const [portraitAssetId, fullBodyAssetId = portraitAssetId] = ids;
  const { presenter } = await post("/api/presenters", { name, portraitAssetId, fullBodyAssetId, isDefault });
  // The worker cuts her face crop; wait up to two minutes to report it.
  for (let i = 0; i < 24 && !presenter.ready; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const listed = await (await fetch("/api/presenters", { cache: "no-store" })).json();
    Object.assign(presenter, listed.presenters.find(kit => kit.id === presenter.id) ?? {});
    if (!presenter.ready && !presenter.status.startsWith("Preparing")) break;
  }
  return { presenter, portraitAssetId, fullBodyAssetId };
}

async function evaluateInTab(cdp, origin, fn, arg) {
  const targets = await (await fetch(`${cdp}/json/list`)).json();
  const page = targets.find(target => target.type === "page" && target.url.startsWith(origin));
  if (!page) throw new Error(`No tab on ${origin} in the Chrome at ${cdp}. Open ${origin}, sign in to the workspace, and run this again.`);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("Could not attach to the tab.")); });
  try {
    const answer = new Promise((resolve, reject) => {
      socket.onmessage = event => { const message = JSON.parse(event.data); if (message.id === 1) resolve(message); };
      socket.onclose = () => reject(new Error("The tab closed."));
    });
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `(${fn.toString()})(${JSON.stringify(arg)})`, awaitPromise: true, returnByValue: true } }));
    const message = await answer;
    if (message.error) throw new Error(message.error.message);
    if (message.result.exceptionDetails) throw new Error(message.result.exceptionDetails.exception?.description ?? message.result.exceptionDetails.text);
    return { tab: page.url, value: message.result.result.value };
  } finally { socket.close(); }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const portrait = await load(args.portrait);
  const same = path.resolve(args.portrait) === path.resolve(args.fullBody);
  const fullBody = same ? portrait : await load(args.fullBody);
  for (const [what, item] of [["portrait", portrait], ["full-length", fullBody]]) console.log(`${what}: ${item.fileName} · ${item.contentType} · ${item.width}×${item.height} · ${(item.bytes.length / 1024).toFixed(0)} KB`);
  if (same) console.log("The same still is the portrait and the full-length photo; it is uploaded once.");
  console.log(`Kit "${args.name}" on ${args.origin}${args.isDefault ? ", as the workspace default" : ""}, through the tab in the Chrome at ${args.cdp}.`);
  if (args.dryRun) { console.log("Dry run: nothing uploaded."); return; }
  const stills = (same ? [portrait] : [portrait, fullBody]).map(item => ({ fileName: item.fileName, contentType: item.contentType, width: item.width, height: item.height, base64: item.bytes.toString("base64") }));
  const { tab, value } = await evaluateInTab(args.cdp, args.origin, inTab, { stills, name: args.name, isDefault: args.isDefault });
  console.log(`Through ${tab}:`);
  console.log(`portrait asset ${value.portraitAssetId}, full-length asset ${value.fullBodyAssetId}`);
  console.log(`presenter ${value.presenter.id} "${value.presenter.name}"${value.presenter.isDefault ? " (default)" : ""}: ${value.presenter.status}`);
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
