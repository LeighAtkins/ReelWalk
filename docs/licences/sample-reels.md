# Landing showpieces: sources and licences (2026-10-26)

Everything on screen was made in ReelWalk with its own tools, in the owner's workspace "ReelWalk" (`cmuy51nnw000h01adf9ks11xo`):
- MCP `apply_commands`: in/out points, order, speed, filter, `zoom-in`, transitions, hook, end card, music;
- the app's `/api/reels/:id/look` route (colour match, tried and then cleared on both);
- the editor's Export button.

ffmpeg was used only for:
- upload transcodes (scale and length cap, described per reel below);
- the 720p delivery transcode;
- the poster and the raw-clips grid.

Hooks are fictional. The suburbs are real places, but no listing exists and the footage is stock, not those houses.

Photographer names come from Pexels' own search data (the `__NEXT_DATA__` of pexels.com search pages, read in the agent Chrome), so each name is confirmed against its clip id. Every clip is under the Pexels License, free to use.

Per-cut technique notes follow the licences, under "Cut log".

## A: "Cut to the beat" (shipped)

| | |
|---|---|
| Reel id | `cmvov7wi5003r01adsm9am1a7` ("Landing sample - Cut to the beat") |
| Export id | `cmvow60l5005b01ad3pgrljf2` |
| Duration | 28.0 s; 13 shots plus the end card |
| Hook | "Avalon Beach / 4 bedrooms · A$4.6M" |
| End card | "ReelWalk · For sale", cut, 4 beats |
| Music | "Cat Walk" by Arulo (Mixkit), Mixkit Stock Music Free License; starts 16.37 s into the track |
| Files | `samples/au-cut-to-the-beat-720.mp4` (https://dh5xvp6apljoh.cloudfront.net/samples/au-cut-to-the-beat-720.mp4), `samples/au-cut-to-the-beat-poster.jpg` (https://dh5xvp6apljoh.cloudfront.net/samples/au-cut-to-the-beat-poster.jpg) |

Upload transcode: vertical 2160×3840 sources scaled to 1080×1920 and capped at 12 s (the aerial at 4–16 s). No re-framing; the sources are already vertical.

| Pexels id | Photographer | Page | Licence |
|---|---|---|---|
| 38413547 | Alef Morais | https://www.pexels.com/video/luxury-villa-with-infinity-pool-and-wooden-deck-38413547/ | Pexels License, free to use |
| 38413586 | Alef Morais | https://www.pexels.com/video/aerial-view-of-luxury-tropical-villa-with-pool-38413586/ | Pexels License, free to use |
| 38413584 | Alef Morais | Pexels video 38413584 (front exterior; title not captured) | Pexels License, free to use |
| 38413572 | Alef Morais | https://www.pexels.com/video/luxury-tropical-villa-with-poolside-deck-38413572/ | Pexels License, free to use |
| 38413564 | Alef Morais | https://www.pexels.com/video/spacious-modern-home-interior-with-natural-light-38413564/ | Pexels License, free to use |
| 38413550 | Alef Morais | Pexels video 38413550 (glassware detail) | Pexels License, free to use |
| 38413548 | Alef Morais | Pexels video 38413548 (kitchen) | Pexels License, free to use |
| 38413582 | Alef Morais | https://www.pexels.com/video/modern-cozy-bedroom-with-natural-light-38413582/ | Pexels License, free to use |
| 38413578 | Alef Morais | Pexels video 38413578 (second bedroom) | Pexels License, free to use |
| 38413573 | Alef Morais | Pexels video 38413573 (garden swing) | Pexels License, free to use |
| 38413575 | Alef Morais | https://www.pexels.com/video/modern-minimalist-dining-room-with-natural-light-38413575/ | Pexels License, free to use |
| 38413574 | Alef Morais | https://www.pexels.com/video/modern-minimalist-home-with-natural-light-38413574/ | Pexels License, free to use |
| 38413585 | Alef Morais | https://www.pexels.com/video/luxurious-modern-villa-with-poolside-deck-38413585/ | Pexels License, free to use |

The photographer is unconfirmed for 38413584, 38413550, 38413548, 38413578 and 38413573. They are consecutive ids from the same upload batch, and every confirmed id in that batch (38413547–38413586) is Alef Morais. Their own pages sat behind Cloudflare and were not opened, so their photographer is inferred from the batch, not read.

## B: "Raw → reel" (shipped)

| | |
|---|---|
| Reel id | `cmvovh8ec004v01adkg1y4qqz` ("Landing sample - Raw to reel") |
| Export id | `cmvow6ii7005e01adh97r4068` |
| Duration | 24.9 s; 12 shots plus the end card |
| N (clips used) | 12 |
| Hook | "Bulimba / four bedrooms, A$2.9M" (dark serif) |
| End card | "ReelWalk · For sale", cut |
| Look | the app's `crisp` preset on every clip (a colour match to one clip was tried and cleared because it cast pink) |
| Music | "Staring at the Night Sky" by Alejandro Magaña (Mixkit), Mixkit Stock Music Free License; starts 8.293 s into the track |
| Files | `samples/au-raw-to-reel-720.mp4` (https://dh5xvp6apljoh.cloudfront.net/samples/au-raw-to-reel-720.mp4), `samples/au-raw-to-reel-poster.jpg` (https://dh5xvp6apljoh.cloudfront.net/samples/au-raw-to-reel-poster.jpg), `samples/au-raw-to-reel-raw.jpg` (https://dh5xvp6apljoh.cloudfront.net/samples/au-raw-to-reel-raw.jpg) (each used clip's first frame as shot, letterboxed, with its as-shot length) |

Upload transcode: the 4K landscape sources were scaled to 1920×1080 at full length. They were not cropped, so the vertical crop and everything else was done in ReelWalk.

| Pexels id | Photographer | Page | Licence |
|---|---|---|---|
| 7578543 | Kindel Media | https://www.pexels.com/video/video-of-a-backyard-7578543/ | Pexels License, free to use |
| 7578540 | Kindel Media | https://www.pexels.com/video/video-of-a-house-interior-7578540/ | Pexels License, free to use |
| 7578547 | Kindel Media | https://www.pexels.com/video/video-of-a-house-interior-7578547/ | Pexels License, free to use |
| 7578548 | Kindel Media | Pexels video 7578548 ("Video of a House Hallway") | Pexels License, free to use |
| 7578542 | Kindel Media | https://www.pexels.com/video/video-footage-of-a-home-interior-7578542/ | Pexels License, free to use |
| 7578552 | Kindel Media | https://www.pexels.com/video/video-of-a-house-interior-7578552/ | Pexels License, free to use |
| 7578544 | Kindel Media | Pexels video 7578544 ("Video of House Interior") | Pexels License, free to use |
| 7578550 | Kindel Media | https://www.pexels.com/video/luxurious-bedroom-and-bathroom-7578550/ | Pexels License, free to use |
| 7578551 | Kindel Media | https://www.pexels.com/video/video-of-a-luxurious-bathroom-7578551/ | Pexels License, free to use |
| 7578554 | Kindel Media | Pexels video 7578554 ("Video of a House Interior") | Pexels License, free to use |
| 7578555 | Kindel Media | https://www.pexels.com/video/table-and-chairs-in-the-backyard-7578555/ | Pexels License, free to use |
| 7578541 | Kindel Media | https://www.pexels.com/video/an-exterior-design-of-a-modern-house-7578541/ | Pexels License, free to use |

## C: "Words on the wall" (not shipped)

Reel `cmvon36vt000g01adkhqh7we2`, reference export `cmvop88z4000n01ad9rqktut4`, 14.9 s. Judged not good enough; see the report. Sources, for the record:
- Two AI presenter shots of "Maya", generated in ReelWalk with Google Veo (library assets `ai-cmvomy32u000f01adrd9g7maq` and `ai-cmvomvz3z000e01adqm0c6zko`, credited "AI-generated with Google Veo"). There is no stock footage.
- Music: "Staring at the Night Sky" by Alejandro Magaña (Mixkit), Mixkit Stock Music Free License, at volume 0.3.

## Withdrawn

The earlier three-house uploads are still in S3 under `samples/`:
- `au-northern-beaches-*` (reel `cmvou5bvi002301ad0g15vmhn`)
- `au-brisbane-queenslander-*` (reel `cmvou5dlh002401ad8kaxmx5n`)
- `au-melbourne-terrace-*` (reel `cmvou5ecs002501adxvgchlnh`, the dropped Melbourne reel; Joolsmagools and Max Vakhtbovych clips)

They are replaced by A and B and should not go into tfvars. Their objects were left in place; nothing was deleted.

## Landing page drawn screens (`apps/web/public/landing/`)

The photos inside the landing page's drawn app screens (`components/landing/mocks.tsx`) are single frames of the
Northern Beaches clips above (Alef Morais, Pexels License, free to use), cut from the 1080x1920 crops with ffmpeg
at 900x1600 and 270x480 (`-s`). They replaced Poly Haven panoramas.

| File | Pexels id | Frame at |
|---|---|---|
| pool.jpg, lap-pool.jpg | 38413547 | 6.0 s, 1.8 s |
| living.jpg, lounge.jpg | 38413564 | 6.0 s, 10.2 s |
| bedroom.jpg | 38413582 | 2.9 s |
| dining.jpg | 38413574 | 5.5 s |
| alfresco.jpg | 38413572 | 3.8 s |
| deck.jpg | 38413585 | 4.8 s |
| aerial.jpg | 38413586 | 6.0 s |
| dining-room.jpg | 38413575 | 3.2 s |

## Cut log

This log covers every shot change in A and B, judged against `output/plans/cut-grammar-2026-10-26.md`. "Used" names the technique as it was built with today's tools: hand-picked in and out points, speed, the four transitions (cut, focusPull, lightLeak, softDissolve) and the `zoom-in` motion. "Missing" names the technique the cut really wanted that the app cannot do yet.

Camera direction per clip window was measured with OpenCV optical flow (`tools/flow.py`, median flow and divergence at 8 fps). Eye trace was judged by eye from before/after frame pairs (`dl/cutsA.jpg`, `dl/cutsB.jpg`), because the app has no saliency read-out. No sound bridges exist: the stock clips are silent, so every cut's only sound decision is a music beat.

### A: "Cut to the beat"

Reel `cmvov7wi5003r01adsm9am1a7`. Track: Cat Walk, 128.57 BPM, 466.7 ms beat. Every cut is on the beat (audio trace: 0–3 ms off).

| # | Time | From → to | Used | Missing / honest note |
|---|---|---|---|---|
| 1 | 2.33 s | pool deck (pulling back) → aerial (rising, 1.5× speed) | Match on direction: the pull-back continues as the drone rise. This is also a scale surprise. | — |
| 2 | 4.67 s | aerial → front façade | Light change: lightLeak glint on the cut | A real time-of-day or light change. The glint is a post effect. |
| 3 | 6.53 s | façade (pushing in) → pergola (pushing in, drifting right) | Match on direction: the forward push continues | Zoom-through: an eased push into the doorway and out the other side |
| 4 | 7.93 s | pergola → living gallery | Eye-trace cut: the table centre lines up with the corridor's vanishing point; outdoor → indoor reveal | Measured eye-trace (saliency) to set the out point exactly |
| 5 | 10.73 s | living gallery → glassware detail (static, with the reel's one push-in) | Scale jump, wide → macro | The detail is a separate clip, not cropped from the same 4K pixels (needs a source-crop / virtual close-up tool). |
| 6 | 12.13 s | glassware → kitchen | Rack focus (focusPull) | Depth-aware blur. focusPull is a uniform defocus, not a depth map. |
| 7 | 14.00 s | kitchen (pulling back) → main bedroom (pulling back) | Match on direction | — |
| 8 | 16.33 s | main bedroom → second bedroom | Eye-trace cut: the bed sits centre-low in both | Measured eye trace; shape match (bed → bed) |
| 9 | 17.73 s | second bedroom (pulling back) → garden swing (pulling back and rising) | Match on direction; indoor → garden surprise | Occlusion wipe through the bedroom's glass door |
| 10 | 19.60 s | swing → dining | Rack focus (focusPull) | Depth-aware blur; sound bridge |
| 11 | 21.00 s | dining (pushing in) → living-dining (pushing in, drifting right) | Match on direction | — |
| 12 | 23.33 s | living-dining → poolside deck | Light change: lightLeak glint | Real light change. This is the second glint (two is the limit). |
| 13 | 26.13 s | poolside → end card (cut, 4 beats, ends on a bar) | Cut on the bar line after the build | — |

Against the rule:
- No naked cuts.
- Match on direction is used five times. It is the reel's spine (the camera keeps travelling), but the rule allows two unless it is a declared signature.
- Surprises land at about 2.3, 4.7, 7.9, 10.7, 12.1, 17.7 and 23.3 s. The 12.1 → 17.7 s gap is 5.6 s, inside the 6 s fail line but over the 3–5 s target.
- There is no motion-free span over 1.5 s except the end card.

### B: "Raw → reel"

Reel `cmvovh8ec004v01adkg1y4qqz`. Track: Staring at the Night Sky, 117.9 BPM, 508.9 ms beat. The music start was moved to 8293 ms so the cuts land on the app's beat grid (beatOffsetMs 151).

| # | Time | From → to | Used | Missing / honest note |
|---|---|---|---|---|
| 1 | 2.54 s | backyard (pushing in toward the glass doors) → kitchen/living (pushing in, drifting right) | Match on direction: the walk "goes through" the sliding doors | Cut on action through the doorway. The source never actually crosses the threshold, so a zoom-through is needed. |
| 2 | 4.07 s | kitchen → living | Eye-trace cut: the corridor vanishing point is centred in both | Measured eye trace |
| 3 | 6.62 s | living (pushing in) → hallway (pushing in) | Match on direction: the forward walk continues | — |
| 4 | 7.64 s | hallway → dining | Rack focus (focusPull) | Depth-aware blur |
| 5 | 8.65 s | dining (pushing in) → dining room (pushing in, drifting right) | Match on direction | Shape match (chair → chandelier) |
| 6 | 11.20 s | dining room → stairs | Light change: lightLeak on the window flare | — (the source flare makes this the most natural glint) |
| 7 | 12.22 s | stairs (drifting left) → bedroom (drifting left) | Match on lateral direction | — |
| 8 | 14.25 s | bedroom → bath | Eye-trace cut: the bright window to the bright window | Measured eye trace |
| 9 | 15.27 s | bath (pulling back) → lounge chairs | Rack focus (focusPull) | Depth-aware blur |
| 10 | 16.80 s | lounge → alfresco | Light change: lightLeak, interior → sun | Second glint (the limit) |
| 11 | 18.32 s | alfresco → rear façade | Cut on the beat after the build | Zoom-out / reveal (an eased pull-back to the whole house) |
| 12 | 22.90 s | façade → end card | Cut | The end card does not land on a bar (721 ms off) |

Against the rule:
- No naked cuts. Match on direction is used four times, never twice in a row.
- The last shot is 4.6 s long (18.3 → 22.9 s) with no surprise. It is a slow push-in on the façade, inside the 6 s fail line.

### What the editor lacked (for the agents building these)

1. **Source crop / virtual close-up from the full-resolution file.** A same-pixels scale jump was not possible: uploads above 32 MB are refused, so 4K sources arrive downscaled, and `zoom` only crops about the centre.
2. **Eased push to a target region, matched on the next shot** (zoom-through). The `camera` keyframes exist in the schema but are not usable by hand from commands without coordinates per frame.
3. **Saliency / eye-trace read-out per shot end** (where the eye is at the last frame).
4. **Optical-flow direction per window** inside the app, so "match on direction" can be chosen rather than measured outside.
5. **Depth-aware rack focus**: focusPull blurs the whole frame evenly.
6. **Occlusion / mask wipe** along a door frame or pillar.
7. **Sound bridges** for silent stock: per-room ambience or J/L-cut offsets.
8. **Export-dialog false positives.** It flags in-camera gimbal moves as "plays exactly as the file came" and asks for a push-in on every shot. It also flagged B's cuts as off-beat when the music start sat on a different beat phase; get_checks agreed with it on one export and not on another.
