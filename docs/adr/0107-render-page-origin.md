# 0107 — The render page has one origin

Date: 2026-11-03

## Context

Exports with a person matte (titles behind the presenter, ADR 0039) failed on the owner's PC worker (ADR 0094) with
`Person matte for clip …: frame … could not be matted: video error 4`, after Chrome logged `net::ERR_FAILED` for the
footage. On 3 November four PC exports of three reels, the Byron reel among them, failed this way at preflight, each after
three attempts.

The matte decodes the clip in its own `<video crossOrigin="anonymous">` (`PersonMatte.tsx`), because it reads the
pixels back. The source is a presigned S3 URL (`apps/worker/src/render.ts`). That makes it a CORS request from the
render page's origin. The media bucket allows `media_cors_origins` plus App Runner's address. Live, on 3 November:
`https://reelwalking.com`, `http://localhost:3000`, `http://localhost:8080` and the App Runner URL.

The page's origin was not fixed. Given a bundle directory, Remotion 4.0.538 starts an HTTP server for every
`selectComposition`, `renderStill` and `renderMedia` call (`prepareServer` → `serveStatic`). Each takes the first free
port from 3000 to 3100 on 127.0.0.1 and names the page `http://localhost:<port>`. Preflight (ADR 0042) draws three stills
at once in one browser, so three servers are up together, on :3000, :3001 and :3002. A matte checkpoint that lands on
:3001 or :3002 gets no `Access-Control-Allow-Origin`, and Chrome refuses the video.

The same presigned object with a `Range: bytes=0-0` GET, from this PC:

| `Origin` | Status | `Access-Control-Allow-Origin` |
| --- | --- | --- |
| `http://localhost:3000` | 206 | `http://localhost:3000` |
| `http://localhost:3001` | 206 | none |
| `http://localhost:3002` | 206 | none |
| `http://127.0.0.1:3000` | 206 | none |

The cloud worker draws the same three stills at once (`RENDER_CONCURRENCY` 3 on 4 vCPU), so it isn't immune; it's the
same draw. Cloud export `cmw0hqbze00dc01adkdzoe8us` failed with `video error 4` at 09:33, and several cloud exports of
the Byron reel only succeeded at attempt 2. Which lane lands on which port depends on timing, so the PC lost more often,
not every time. The "localhost CORS" timeout on the earlier board reel is likely the same cause.

## Decision

The worker serves the bundle itself, once per process, on `RENDER_PAGE_PORT` = 3000
(`packages/render/src/bundle-server.ts`). It hands Remotion that URL as the serve URL instead of the bundle directory.
Every page of every call then has the origin `http://localhost:3000`, which the bucket and CloudFront already allow.
Remotion still starts its own video proxy server per call, on the next free port; only the page moves. The server:

- binds 127.0.0.1, as Remotion's does;
- answers GET and HEAD with single byte ranges;
- serves nothing outside the bundle;
- doesn't keep the process alive, so an idle worker still exits.

If port 3000 is taken (a script run on a machine with `next dev` on it), `getServeUrl` logs a warning and falls back to
the bundle directory, as before.

A test reads `media_cors_origins` from `infra/terraform/variables.tf` and fails if `http://localhost:3000` leaves it.
That origin is now load-bearing for every render.

### Not chosen

- **Add `http://localhost:3001` and `:3002` to the bucket's CORS.** That widens production CORS to fit a port lottery,
  and a fourth lane or a stray server would break it again.
- **Chrome's `disableWebSecurity` for renders.** That is broader than this needs: the render browser could then read any
  origin, including the task's metadata endpoint.
- **One still at a time in preflight.** That gives back the time ADR 0042's three lanes saved, and `renderMedia` alone
  would still depend on 3000 being the first free port.

## Consequences

- No infrastructure change: no Terraform plan, no CORS edit.
- Both workers draw mattes reliably, from the next worker image. The PC picks it up from `start.sh` once it's deployed.
- `media_cors_origins` must keep `http://localhost:3000` while renders read media straight from the bucket.

## Verified

- Unit tests: the server's types, ranges, HEAD, 404 outside the bundle and on missing files, 405 on POST,
  `EADDRINUSE` on a taken port, and the CORS-list check.
- Still to do after deploy: re-export reel `cmvzz7msn006301adbua4iv01` (Byron, a matte title) on the PC worker. The log
  should show `preflight: every shot drew` and the job should succeed at attempt 1.
