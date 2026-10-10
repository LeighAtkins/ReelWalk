import { expect, test } from "@playwright/test";

// Requests from someone who is not signed in: no cookies at all.
test.use({ storageState: { cookies: [], origins: [] } });

test("there is no unauthenticated render endpoint", async ({ request }) => {
  // It queued renders of client-chosen media URLs as the demo workspace (SSRF).
  const project = {
    id: "x",
    tracks: [{ id: "t", type: "image", name: "t", visible: true, clips: [{ id: "c", type: "image", name: "c", assetUrl: "http://10.0.0.1/a.png", startFrame: 0, durationFrames: 30 }] }],
  };
  const queued = await request.post("/api/editor/render", { data: project });
  expect(queued.status()).toBe(404);
  expect((await request.get("/api/editor/render/anything")).status()).toBe(404);
});

test("autosave refuses a request without a session", async ({ request }) => {
  const response = await request.post("/api/reels/anything/save", { data: { revision: 0, timeline: {} } });
  expect(response.status()).toBe(401);
});
