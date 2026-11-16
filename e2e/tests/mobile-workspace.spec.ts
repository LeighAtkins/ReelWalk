import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";
import { DEMO_EMAIL, DEMO_PASSWORD } from "../demo-user";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");
const fixturePath = (name: string) => (name === "living-room.jpg" ? process.env.E2E_INTERIOR_PHOTO : name === "exterior.jpg" ? process.env.E2E_EXTERIOR_PHOTO : undefined) ?? path.join(fixtures, name);
test.skip(process.env.E2E_LOCAL_STACK_VERIFIED !== "1", "Run with mobile-workspace.config.ts against a verified isolated local stack.");
type Asset = { id: string; url: string; kind: string; [key: string]: unknown };
type Payload = { requestId: string; action?: string; role?: string; source?: { assetId: string }; continuity?: { assetId: string }; guidedPair?: { endRequestId: string }; [key: string]: unknown };
type Card = { id: string; clipId?: string; framePair?: { startRequestId: string; endRequestId: string; startAssetId?: string; endRevision?: { requestId: string; assetId?: string } }; request?: { id: string; jobId?: string }; [key: string]: unknown };
type Timeline = { shotBoard?: { cards: Card[] }; clips: { id: string; assetId: string }[] };
type FrameJob = { id: string; requestId: string; status: string; input: Payload; asset: Asset | null; candidateUrl: string | null; sourceUrl: string; error: string | null };
const board = (page: Page) => page.getByRole("region", { name: "Shot board", exact: true });
const shot = (page: Page) => page.getByRole("dialog", { name: "Shot 2", exact: true });
const cards = (timeline: Timeline) => timeline.shotBoard?.cards ?? [];

async function uploadFixture(page: Page, baseURL: string, fileName: string): Promise<Asset> {
  const data = await readFile(fixturePath(fileName));
  const dimensions = await page.evaluate(async encoded => {
    const image = new Image();
    image.src = `data:image/jpeg;base64,${encoded}`;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  }, data.toString("base64"));
  const contentType = "image/jpeg";
  const response = await page.request.post("/api/uploads", { headers: { origin: baseURL }, data: { fileName: `workspace-e2e-${Date.now()}-${fileName}`, contentType, sizeBytes: data.length, withThumbnail: false } });
  expect(response.ok(), await response.text()).toBeTruthy();
  const ticket = await response.json();
  expect(ticket.ok).toBe(true);
  expect(["localhost", "127.0.0.1"]).toContain(new URL(ticket.uploadUrl).hostname);
  expect((await page.request.put(ticket.uploadUrl, { headers: { "content-type": contentType }, data })).ok()).toBeTruthy();
  const confirmed = await page.request.post("/api/uploads/confirm", { headers: { origin: baseURL }, data: {
    objectKey: ticket.objectKey, thumbKey: null, fileName: `workspace-e2e-${fileName}`,
    durationMs: null, ...dimensions,
  } });
  expect(confirmed.ok(), await confirmed.text()).toBeTruthy();
  const result = await confirmed.json();
  expect(result.ok).toBe(true);
  return result.asset;
}

/** Intercepts every AI route before the app loads. Real auth, uploads, SSR,
 * hydration and autosave are retained. No generated IDs bypass media ownership. */
async function fixture(page: Page, baseURL: string, photo: string, failVideoAdmission = false) {
  const unexpected: string[] = [], framePosts: Payload[] = [], videoPosts: Payload[] = [], saved: Timeline[] = [];
  const jobs = new Map<string, FrameJob>();
  let frameStatus = "CANDIDATE", videoStatus = "RUNNING", disconnect = false, brokenPreview = false;
  let videoAdmissionFailed = failVideoAdmission, videoGets = 0;
  let video: Record<string, unknown> | undefined;
  const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, json: value });
  page.on("response", async response => {
    if (!/\/api\/reels\/[^/]+\/save$/.test(new URL(response.url()).pathname)) return;
    try {
      const { timeline } = response.request().postDataJSON() as { timeline?: Timeline };
      if (timeline && response.ok() && (await response.json()).ok) saved.push(timeline);
    } catch { /* Only acknowledged, readable timeline saves count. */ }
  });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (!["http:", "https:"].includes(url.protocol)) return route.continue();
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
      unexpected.push(`${route.request().method()} ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    if (url.pathname === "/__workspace-preview.jpg") {
      return brokenPreview ? route.fulfill({ status: 503, body: "fixture unavailable" }) : route.fulfill({ contentType: "image/jpeg", body: await readFile(fixturePath(photo)) });
    }
    if (url.pathname === "/__workspace-video.mp4") return route.fulfill({ contentType: "video/mp4", body: await readFile(path.join(fixtures, "walkthrough.mp4")) });
    if (url.pathname === "/api/ai/keyframes") {
      if (route.request().method() === "GET") {
        if (disconnect) return json(route, { error: "Local fixture disconnected" }, 503);
        const requestId = url.searchParams.get("requestId");
        return json(route, { enabled: true, reason: null, balanceRemaining: 100, jobs: [...jobs.values()].filter(job => !requestId || job.requestId === requestId) });
      }
      const input = route.request().postDataJSON() as Payload;
      if (input.action === "use") {
        const job = [...jobs.values()].find(job => job.id === input.jobId);
        expect(job).toBeDefined();
        job!.status = "USED";
        return json(route, { asset: job!.asset });
      }
      expect(input.action).toBe("generate");
      // Dispatch is permitted only after the real server acknowledged the request identity.
      await expect.poll(() => saved.some(t => cards(t).some(c => c.framePair?.startRequestId === input.requestId || c.framePair?.endRevision?.requestId === input.requestId))).toBe(true);
      framePosts.push(input);
      const make = (id: string, asset: Asset, role: string): FrameJob => ({ id: `job-${id}`, requestId: id, status: frameStatus, input: { ...input, role },
        asset: frameStatus === "CANDIDATE" ? asset : null, candidateUrl: frameStatus === "CANDIDATE" ? `${asset.url}` : null,
        sourceUrl: "/__workspace-preview.jpg", error: frameStatus === "FAILED" ? "Fixture preparation failed" : null });
      jobs.set(input.requestId, make(input.requestId, input.role === "end" ? assets.revised : assets.start, input.role!));
      if (input.guidedPair) jobs.set(input.guidedPair.endRequestId, make(input.guidedPair.endRequestId, assets.end, "end"));
      return json(route, { id: `job-${input.requestId}` });
    }
    if (url.pathname === "/api/ai/generations") {
      if (route.request().method() === "GET") {
        videoGets++;
        if (disconnect || videoAdmissionFailed) return json(route, { error: "Local fixture disconnected" }, 503);
        return json(route, { enabled: true, balance: { remaining: 100, monthly: 100, trial: 0, topUp: 0 }, jobs: video ? [{ ...video, status: videoStatus, asset: videoStatus === "SUCCEEDED" ? assets.video : null, error: videoStatus === "FAILED" ? "Fixture video failed" : null }] : [] });
      }
      const input = route.request().postDataJSON() as Payload;
      await expect.poll(() => saved.some(t => cards(t).some(c => c.request?.id === input.requestId))).toBe(true);
      videoPosts.push(input);
      video = { ...input, id: `video-${input.requestId}`, createdAt: new Date().toISOString(), draftId: null };
      return json(route, { id: video.id });
    }
    if (url.pathname.startsWith("/api/ai/") || /\/(autopilot|ai-edit|rooms|finish|render|exports)(\/|$)/.test(url.pathname)) {
      unexpected.push(`${route.request().method()} ${url.pathname}`);
      return json(route, { error: "Unmocked provider-capable route blocked by local E2E" }, 503);
    }
    return route.continue();
  });
  await page.goto("/login");
  await page.getByLabel("Email").fill(DEMO_EMAIL);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("start-blank-board")).toBeVisible();
  const assets: { start: Asset; end: Asset; revised: Asset; video: Asset } = {
    start: await uploadFixture(page, baseURL, photo), end: await uploadFixture(page, baseURL, photo),
    revised: await uploadFixture(page, baseURL, photo),
    // Existing, owned local fixture avoids enqueueing even a preview render.
    video: { id: process.env.E2E_VIDEO_ASSET_ID!, kind: "VIDEO", fileName: "walkthrough.mp4", url: "/__workspace-video.mp4", thumbUrl: null,
      durationMs: 2000, width: 540, height: 960, isPano: false, credit: null, tourId: null, spot: null, room: null,
      bpm: null, beatOffsetMs: null, songMap: null, previewPending: false, instagram: null, transcript: null },
  };
  await page.getByTestId("start-blank-board").click();
  await expect(page).toHaveURL(/\/reels\/[^/]+$/);
  while (await board(page).getByRole("article").count() < 2) await board(page).getByRole("button", { name: "+ Add shot", exact: true }).click();
  const target = board(page).getByRole("article").nth(1);
  await target.locator('input[type="file"]').setInputFiles(fixturePath(photo));
  await expect(target.getByRole("img", { name: "Shot 2 source" })).toBeVisible();
  await target.getByRole("button", { name: "Prepare Start / End", exact: true }).click();
  await expect(shot(page)).toBeVisible();
  return { assets, jobs, framePosts, videoPosts, saved, unexpected,
    setFrameStatus: (status: string) => { frameStatus = status; },
    setVideoStatus: (status: string) => { videoStatus = status; },
    setDisconnected: (value: boolean) => { disconnect = value; },
    setBrokenPreview: (value: boolean) => { brokenPreview = value; },
    setVideoAdmissionFailed: (value: boolean) => { videoAdmissionFailed = value; },
    videoGetCount: () => videoGets,
  };
}

async function reopen(page: Page, reload = false) {
  await shot(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-status", "saved");
  if (reload) await page.reload();
  await board(page).getByRole("article").nth(1).getByRole("button", { name: /Open saved shot|Continue shot|Prepare Start/ }).click();
  await expect(shot(page)).toBeVisible();
}

async function screenshot(page: Page, info: TestInfo, label: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const file = info.outputPath(`${label}.png`);
  await page.screenshot({ path: file, scale: "css" });
  await info.attach(label, { path: file, contentType: "image/png" });
}

async function approve(page: Page) {
  await shot(page).locator("summary").filter({ hasText: "Compare original photo" }).click();
  await expect(shot(page).getByRole("img", { name: "Original reference photograph" })).toBeVisible();
  await shot(page).locator("summary").filter({ hasText: "Compare original photo" }).click();
  const use = shot(page).getByRole("button", { name: "Use these frames", exact: true });
  await expect(use).toBeDisabled();
  await shot(page).getByRole("checkbox", { name: /I compared/ }).check();
  await use.click();
  await expect(shot(page).getByRole("button", { name: /Generate video/ })).toBeEnabled();
}

test("photo to revised pair to video survives reload and places only the intended shot", async ({ page, baseURL }, info) => {
  const photo = info.project.name.endsWith("390") ? "living-room.jpg" : "exterior.jpg";
  const f = await fixture(page, baseURL!, photo);
  const prepare = shot(page).getByRole("button", { name: /Prepare Start and End/ });
  await expect(prepare).toBeEnabled();
  const actionBox = (await prepare.boundingBox())!;
  expect(actionBox.y).toBeGreaterThanOrEqual(0);
  expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await screenshot(page, info, "initial-photo-workspace");
  f.setFrameStatus("SUBMITTING");
  await prepare.dblclick();
  await expect(shot(page).getByRole("progressbar", { name: "Start image progress" })).toBeVisible();
  await reopen(page, true);
  expect(f.framePosts).toHaveLength(1);
  for (const job of f.jobs.values()) { job.status = "CANDIDATE"; job.asset = job.input.role === "start" ? f.assets.start : f.assets.end; job.candidateUrl = job.asset.url; }
  f.setFrameStatus("CANDIDATE");
  await expect(shot(page).getByRole("button", { name: "Use these frames", exact: true })).toBeVisible();
  expect(f.framePosts).toHaveLength(1);
  await reopen(page, true);
  await approve(page);
  await shot(page).getByRole("button", { name: "Adjust End only", exact: true }).click();
  await shot(page).getByPlaceholder("For example: rise further above the pool and finish at dusk. Keep the house unchanged.").fill("Preserve the same materials and keep the original light.");
  await shot(page).getByRole("button", { name: /Generate End only/ }).dblclick();
  await expect.poll(() => f.framePosts.length).toBe(2);
  expect(f.framePosts[1]).toMatchObject({ role: "end", continuity: { assetId: f.assets.start.id }, source: f.framePosts[0].source });
  expect(f.framePosts.filter(p => p.role === "start")).toHaveLength(1);
  await expect(shot(page).getByRole("button", { name: /Generate video/ })).toBeHidden();
  await reopen(page, true);
  expect(f.framePosts).toHaveLength(2);
  await expect(shot(page).getByRole("img", { name: "Prepared Start frame", exact: true })).toHaveAttribute("src", f.assets.start.url);
  await screenshot(page, info, "revised-pair-review");
  await approve(page);
  await shot(page).getByRole("button", { name: /Generate video/ }).dblclick();
  await expect.poll(() => f.videoPosts.length).toBe(1);
  expect(f.videoPosts[0].shot).toMatchObject({ first: { assetId: f.assets.start.id }, last: { assetId: f.assets.revised.id } });
  await reopen(page, true);
  await expect(shot(page).getByRole("button", { name: "Check saved video request" })).toBeVisible();
  expect(f.videoPosts).toHaveLength(1);
  f.setVideoStatus("UNRESOLVED");
  await shot(page).getByRole("button", { name: "Check saved video request" }).click();
  await expect(shot(page).getByText("The outcome is not confirmed.", { exact: false })).toBeVisible();
  await reopen(page, true);
  f.setVideoStatus("FAILED");
  await shot(page).getByRole("button", { name: "Check saved video request" }).click();
  await expect(shot(page).getByText("Fixture video failed", { exact: true })).toBeVisible();
  expect(f.videoPosts).toHaveLength(1);
  f.setVideoStatus("SUCCEEDED");
  await shot(page).getByRole("button", { name: "Check saved video request" }).click();
  const preview = shot(page).getByLabel("Generated AI clip");
  await expect.poll(() => preview.evaluate(el => (el as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
  await preview.evaluate(async el => { const video = el as HTMLVideoElement; video.muted = true; await video.play(); });
  await expect.poll(() => preview.evaluate(el => (el as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
  const useShot = shot(page).getByRole("button", { name: "Use shot", exact: true });
  const resultActionBox = (await useShot.boundingBox())!;
  expect(resultActionBox.y).toBeGreaterThanOrEqual(0);
  expect(resultActionBox.y + resultActionBox.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await screenshot(page, info, "playable-result");
  await useShot.click();
  await expect(board(page).getByRole("article").nth(1).getByRole("heading")).toHaveText("Shot 2 - Ready");
  await expect(board(page).getByRole("article").first().getByRole("heading")).toHaveText("Shot 1 - Empty");
  await expect.poll(() => f.saved.some(t => { const c = cards(t); return !c[0]?.clipId && !!c[1]?.clipId && t.clips.some(clip => clip.id === c[1].clipId && clip.assetId === f.assets.video.id); })).toBe(true);
  await page.reload();
  await expect(board(page).getByLabel("Shot 2 video")).toBeVisible();
  expect(f.videoPosts).toHaveLength(1);
  expect(f.unexpected).toEqual([]);
});

test("UNKNOWN and disconnected preparation retain identity; failed preview cannot approve", async ({ page, baseURL }, info) => {
  const f = await fixture(page, baseURL!, "exterior.jpg", true);
  const retryAdmission = shot(page).getByRole("button", { name: "Retry video status", exact: true });
  await expect(retryAdmission).toBeVisible();
  const getsBefore = f.videoGetCount();
  f.setVideoAdmissionFailed(false);
  await retryAdmission.click();
  await expect(retryAdmission).toBeHidden();
  expect(f.videoGetCount()).toBe(getsBefore + 1);
  expect(f.framePosts).toHaveLength(0);
  expect(f.videoPosts).toHaveLength(0);
  f.setFrameStatus("UNKNOWN");
  await shot(page).getByRole("button", { name: /Prepare Start and End/ }).dblclick();
  await expect(shot(page).getByRole("button", { name: "Check saved result" }).first()).toBeVisible();
  await reopen(page, true);
  await shot(page).getByRole("button", { name: "Check saved result" }).first().click();
  f.setDisconnected(true);
  await shot(page).getByRole("button", { name: "Check saved result" }).first().click();
  await expect(shot(page).getByRole("button", { name: "Retry status check" })).toBeVisible();
  await reopen(page, true);
  expect(f.framePosts).toHaveLength(1);
  expect(f.videoPosts).toHaveLength(0);
  await expect(shot(page).getByRole("button", { name: /Prepare Start and End|Generate video/ })).toBeHidden();
  f.setDisconnected(false);
  f.setBrokenPreview(true);
  for (const job of f.jobs.values()) { job.status = "CANDIDATE"; job.asset = job.input.role === "start" ? f.assets.start : f.assets.end; job.candidateUrl = "/__workspace-preview.jpg"; }
  await shot(page).getByRole("button", { name: "Retry status check" }).click();
  await expect(shot(page).getByText("A preview could not load.", { exact: false })).toBeVisible();
  await expect(shot(page).getByRole("button", { name: "Use these frames", exact: true })).toBeDisabled();
  await expect(shot(page).getByRole("checkbox", { name: /I compared/ })).toBeDisabled();
  await screenshot(page, info, "failed-preview-blocks-approval");
  expect(f.framePosts).toHaveLength(1);
  expect(f.unexpected).toEqual([]);
});

