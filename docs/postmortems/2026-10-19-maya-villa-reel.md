# Post-mortem: "Dropped In — Maya's Villa Tour" (18–19 October 2026)

A 30-second reel with an AI presenter (Maya) who skydives out of a plane,
crashes through the roof of a real villa and talks the viewer through it.
The owner's goal was to direct it entirely through Opus inside the app. In
practice it took about 20 hours, nine app PRs, two credit grants, nine Veo
takes made by the app (two kept) and a dozen hand-run scripts. This records
what went wrong and what the app needs so the next one is close to one shot.

Scheduled for 19 October, 20:00 MYT, with Instagram's AI info label.

## Timeline

| Stage | What happened |
|---|---|
| Night of 18 Oct | The first cut was assembled by scripts outside the app. The owner rejected it: the skydive read as a flat photo that she dived *out* of, the presenter vanished between cuts, and she was gigantic next to the house. |
| 18 Oct, evening | The owner asked for all direction to happen *in the app*. PR #99 added "Direct and review with Opus". It had only been tested against a mocked model. |
| 19 Oct, 07:00–11:00 | Every live run of the in-app director failed in a new way. Seven fixes shipped one after another (below). The first full review landed about four hours after the first attempt. |
| 11:00–12:30 | Opus's reviews agreed with the owner but kept proposing skydives that Veo could not deliver. Five takes failed on scale or direction. |
| 12:30–13:30 | Anchoring Veo with two composited stills (start and end) produced the first skydive that passed. The owner then asked for a plane-door opening with a spoken quip and a cleaner ending. |
| 13:30–14:00 | A voiced plane take, caption retiming from a transcript, the end card and the AI info label. Export, verify, schedule. |

## What we had to fix

### A. The in-app director did not work live (seven bugs, each hidden by the one before)

| PR | Bug | Fix |
|---|---|---|
| #107 | Anthropic rejected the request: `Enum value 0.5 does not match declared type`. The director schema embedded the edit plan, whose fractional enums Claude refuses. Plain edits already had a transport encoding; the director path skipped it. | Apply the same encoding to the nested edit plan. |
| #108 | The provider call had a 60-second timeout. Opus thinking over a dozen frame sheets takes longer, so reviews died with "Could not reach Claude". | 300 s for director reviews (they already run as background jobs). Also the simplified screen: one box, no file-name checklists. |
| #109 | One stalled video seek during frame sampling aborted the whole review. | Retry the seek once, keep captured frames, skip an unreadable clip and say so. |
| #110 | A complete, paid review was discarded because one evidence string ran past 600 characters. | Trim prose for people; keep the Veo prompt strict. |
| #111 | "Apply these changes" always said the reel had been edited since. The server's copy of the timeline is parsed (field order, defaults), so raw JSON never matched. | Compare parsed, key-sorted timelines. |
| #114 | With the rule that described changes must be real operations, a full plan plus Opus's thinking exceeded the 10k output-token cap: "Claude stopped before completing the edit plan". | 30k tokens for director reviews. |
| #115 | Two reviews described caption moves, trims and a new prompt but returned empty `edit.ops` and `shots`. Reproduced live: with the summary first in the schema, Opus summarised and then emitted empty arrays; with `edit` and `shots` first it returned them every time. | Reorder the schema; refuse a needs-generation verdict with no shot. |
| #117 | A proposed retry with an ending frame but no starting frame discarded the whole review. | Drop the stray frame; the shot becomes text-only. |
| (pending) | `edit.note` over 400 characters discarded a review. | Same trimming as #110. Worked around in the brief. |

Lesson: a feature that calls a model must be tested against the real model
at least once before it ships. Mocks proved the UI; they could not prove the
schema, the timeout, the token budget or the output order.

### B. Opus's decisions were right; the plumbing lost them

| PR | Problem | Fix |
|---|---|---|
| #116 | Opus wrote `order [3,2,...]` then `remove clip 2`, counting from its reordered view. The app numbers every operation from the description it showed (correct, keeps operations independent), so it removed the presenter take Opus meant to keep and left the broken stunt in. | State the rule in the prompt; a test pins it. |
| #112 | A voiced Veo take invents its own voice. The reel had two takes, so Maya switched from an American to an Australian accent mid-reel. Opus reviews stills and cannot hear. | Rule: keep speech from at most one AI take; mute the rest and caption their lines. |
| #112 | The instructions said to hold all edits while a take was pending, so a review's safe edits (captions, trims, mutes) never applied. | Independent edits apply now; the note may only describe what is in the plan. |

### C. Veo failures (nine app takes, two kept)

| Take | Why it failed |
|---|---|
| 8 s continuous skydive from the exterior frame | She launched *up* from the lawn, breached the front wall outside but fell from a ceiling hole inside, hair changed mid-shot. |
| Text-only skydive | Flew level toward the facade, a different-looking house, a white bar across the frame. |
| Text-only straight-down | Fell onto a grey-slate suburban house, not the villa. |
| Anchored on the empty villa frame (×2) | Both times she jumped up from the ground before falling; 3.5–5 m tall at the roof. |
| Anchored on a composited "Maya in the sky" still | Fell, but drifted sideways and grew to about 4 m at the roof. |
| **Anchored on start + end stills** (Maya high in the sky; Maya door-height hitting the ridge) | **Passed.** Locked camera, straight down, human-sized. Only the final burst was used. |
| **Ceiling drop** (real empty room → walk-e's first frame) | **Passed** first time, because both ends were real frames. |
| Silent plane-door exit | Superseded when the owner asked for a spoken line. |

Pattern: Veo given one static frame of a building and a person "arriving"
makes the person leave the ground. Given a start *and* an end frame it
interpolates faithfully. Scale is only controllable when the end frame fixes
it. Every passing take was pinned at both ends.

### D. Things Opus could not see, done by hand

| Need | What we did by hand | Cost of not having it in the app |
|---|---|---|
| Caption timing | Transcribed walk-e and the plane take with faster-whisper (word timings), wrote the times into the brief. | Three rounds of "captions are off". |
| Matched cut | Compared every frame of the drop's last 1.5 s against walk-e's first frame (pixel MSE); 3.667 s matched (MSE 13 vs 135+). | One round of "she jumps at the cut". |
| Veo anchoring | Composited start/end stills with Gemini 3 Pro Image from a real frame plus a presenter reference, then shrank her to door height. | Six failed takes (≈ 7 credits). |
| A spoken opener | Ran the separate voiced cloud runner (generateAudio on). The app generates silent video only. | Not possible in-app at all. |
| Music ducking | Not fixed. The score has ducking baked in for dialogue at 8 s; her lines now start at 0 s and 11.6 s. Owner to check by ear. | Risk of music over speech. |
| Loudness | Export measured −17.3 LUFS, true peak +0.1 dBTP. | Marginal clipping; relying on Instagram's normalisation. |

### E. Production and process

- **AI video was off in production for most of the day.** A Terraform deploy
  the previous afternoon dropped `AI_VIDEO_ENABLED` and the Google identity
  settings, which had been set by hand outside Terraform. Restored, and now
  owned by Terraform, so a deploy cannot drop them again.
- **Flaky database tests** failed about one CI run in six and forced re-runs
  on five PRs. Test files ran in parallel against one Postgres and starved
  each other. Fixed in #113 by running them one file at a time (3.6 s total).
- **Deploys are manual:** merge, wait for images, set `image_tag`, plan,
  check that worker env is unchanged, apply. About 25 minutes each; nine today.
- **Credits:** 15 owner credits granted; 10 spent (one 8 s take, eight 4 s
  takes), 5 left. Voiced cloud takes cost about $15.80 of a $20 cap.

## What the app needs for a one-shot reel

Ordered by how many of today's rounds each would have removed.

1. **Transcribe every voiced clip on import** (worker, faster-whisper). Store
   words with timings on the asset. Captions over speech are placed on the
   words automatically; Opus is given the transcript as fact, not a guess.
   Removes the caption rounds and the "I cannot hear" limitation for text.
2. **Keyframe anchoring for Veo.** When Opus proposes a shot, the app
   composites a start and an end still (image model) from a real frame plus
   the presenter reference, with scale pinned to a known object (door,
   chair). Veo interpolates between them. Removes most failed takes.
3. **Mechanical checks before Opus reviews a take:** optical-flow direction
   per 400 ms (we already have this for the forest reel), presenter height
   against detected doors and furniture, identity against the reference.
   Reject cheap failures without spending a review.
4. **Matched-cut finder:** when two presenter clips meet, pick the out-point
   by frame similarity to the next clip's in-point. Expose as "smooth this
   cut".
5. **One voice by construction:** mark voiced assets on import (transcript
   non-empty); the timeline allows one voiced AI presenter take with sound,
   mutes the rest and offers their lines as captions. Not a prompt rule.
6. **Director loop with a budget:** review → approve → generate → re-review
   on completion → insert if it passes, up to N retries within the user's
   credit cap. "Ask me first" shows each quote; "Make it for me" lets Opus
   run the loop.
7. **Voiced generation in-app** with the accent and voice description stored
   per presenter, labelled "voice may differ between takes" until a fixed
   voice (TTS plus lip-sync) exists.
8. **Hard rules in `applyAiEditPlan`,** not Opus discipline: captions inside
   the safe area, no overlapping captions, clip numbers fixed per plan.
9. **Music ducking at render time** from the transcript windows, instead of
   baked into the track.
10. **Loudness normalisation in the export** (−14 LUFS, −1 dBTP).
11. **A recorded live-model fixture in CI** for the director path, so schema,
    timeout and output-order regressions fail before deploy.
12. **A deploy command** that does the merge-wait-plan-check-apply sequence.

Items 1, 3, 4, 8 and 10 are mechanical and cheap. Items 2, 5 and 6 are the
product. Item 7 is the only one that needs a new provider decision.
