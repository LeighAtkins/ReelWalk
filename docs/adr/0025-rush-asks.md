# ADR 0025: What a rushed agent asks for

Status: accepted (2026-10-14)

## Context

Leigh asked for the "Ask" feature to be judged by what an agent in a hurry
would type between appointments, through the app's own prompting, not by
what we can make happen by hand. Thirty such asks were run against the real
model on the three sample reels (`.tools/try-rush.mjs`): 23 did the right
thing. The misses were all about 360 photos ("face the door", "look at the
view", "turn slower", "do a full spin": the model had no way to turn one and
once faked it with a zoom), plus a few answers that were wrong in a small
way: a phone number went on the picture instead of the card, "less shaky"
claimed a change that was not made, "undo that" and "post it" did not say
where the buttons are.

## Decision

- **op `turn`** for 360 photos: `content` names what to face (door, window,
  the view, the bed), `sweep` is how far the camera turns on the way (90,
  180, 360; 0 holds still; negative turns the other way; null keeps the
  sweep it has), `yaw` the heading to end on. When `content` is given and
  `yaw` is not, the web app finds the thing in the equirectangular image
  with the vision model (`lib/pano-aim.ts`: how far across the picture it
  sits, 0 to 1; heading = (x − 0.5) × 360 in the renderer's convention)
  before the plan is applied. Not found: the op is skipped with a reason.
  "Turn slower/faster" is a longer or shorter clip with the same sweep.
- Prompt rules: contact details go on the card; an open-house time is a
  box text at the start and the card's contact; never claim a change that
  was not made; footage cannot be stabilised; where Undo and posting live.

## Consequences

- The promo's third act can show an ask that works on a 360 photo.
- Aiming costs one small vision call per turned clip (about $0.0001).
- The stand-in (DEV_FAKE_AI) cannot look at pictures; it takes the door to
  be a quarter turn to the right, enough for the e2e path.

## Results (2026-10-14, gpt-6-luna, `.tools/try-rush.mjs`)

38 asks on the sample reels. Before: 23 did the right thing. After: all 38
give the right result or say plainly what cannot be done ("less shaky":
"footage can't be stabilized here"). 360 aiming read off the gridded
panorama: bedroom glass door 0.61 (true about 0.62), bed 0.79, wardrobe
0.17, dining-room view 0.49, dining table 0.21, deck sea 0.53; renders of
the bed, wardrobe and table asks end on those things. The first version
sent the stored thumbnail, which for library 360 photos is a flat 59-degree
window: positions read off it were wrong (the door at 0.91).
