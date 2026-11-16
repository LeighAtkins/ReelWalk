# Local mobile shot workspace E2E

Run `mobile-workspace.config.ts` against an already running Next app from this checkout. This is a full hydrated editor test: authentication, photo upload to local object storage, reel creation, ownership checks and autosave are real. Only AI history/dispatch/results and the video playback bytes are mocked. Prepared frame IDs are real locally uploaded assets. No provider calls, renders or publishing are requested.

Prerequisites:

- Verify the app's database, S3/MinIO and queue endpoints are isolated local test services. Disable AI and omit cloud/provider/ECS credentials. A localhost web URL alone does not verify its backing services.
- Seed the usual `demo@reelwalk.local` account; set `E2E_DEMO_PASSWORD` if it differs from `reelwalk-demo`.
- Provide `E2E_VIDEO_ASSET_ID` for an existing demo-owned local `walkthrough.mp4` fixture (540×960, 2 seconds). The suite deliberately does not upload video or enqueue a preview worker. Its ID must survive the app's ownership validation. The underlying local video object must exist for reload playback.
- Have Playwright's Chromium installed, or set `E2E_BROWSER_CHANNEL=msedge` for an installed Edge. This never takes over an existing browser profile.
- Honour the shared-PC heavy lock and cooldown around Next/test execution, including cleanup on failure. Do not run alongside another build/render/full check.

From `e2e`, with the prerequisites verified:

```powershell
$env:E2E_BASE_URL = 'http://localhost:3198'
$env:E2E_LOCAL_STACK_VERIFIED = '1'
$env:E2E_VIDEO_ASSET_ID = '<verified local fixture ID>'
pnpm exec playwright test -c mobile-workspace.config.ts
# Bounded reproduction of one journey:
pnpm exec playwright test -c mobile-workspace.config.ts --project=workspace-390 --grep 'photo to revised'
```

The dedicated config runs two scenarios at 390×844 and 360×740, serially, without retries. It avoids the ordinary setup's unrelated Instagram signup. The ordinary suite skips these local-only tests unless explicitly opted in. Existing timeouts, assertions and scenarios are unchanged.

Coverage: photo/card entry, visible initial action, real save-before-dispatch, repeated clicks, preparing and ready pair reloads, original comparison, manual approval, End-only revision with retained Start and changed notes, approval invalidation, video request reload, unresolved/failed video recovery without another dispatch, playable result and insertion into the second card while the first stays empty; initial video admission failure with GET-only retry; UNKNOWN/disconnected frame recovery; failed image preview blocks approval. Screenshots are attached at CSS viewport dimensions. Every unexpected AI/provider-capable route and external browser request is blocked and fails the scenario.

Optional `E2E_INTERIOR_PHOTO` and `E2E_EXTERIOR_PHOTO` can point to authorized local JPEG references for visual evidence. The browser measures their actual dimensions for upload; the same photo represents prepared Start/End, so this does not test generation quality.

Limitations: bundled JPEGs are synthetic gradient fixtures with different aspect ratios, not property-quality references. This is functional browser evidence, not real generation fidelity, creative approval, real-device keyboard/safe-area acceptance or provider integration. The suite creates local reels and photo assets and retains them for diagnosis. It does not delete existing data or migrate schemas. Removed-card and deliberately out-of-order response races are not covered here.
