# 0030 - Anchor AI shots to real footage and assemble private promo drafts

## Decision

Extend the metered Veo path with continuation, first/last-frame bridges,
transition bursts, photo-to-gimbal and photo-to-drone presets. Keep custom
text/image generation and existing subscriber credits. A preset supplies camera
direction and preservation instructions, rather than asking users to write an
entire generation prompt.

The browser sends library asset IDs and source timestamps. A reel clip supplies
its trimmed last displayed source frame (including playback speed); the next
clip supplies its first source frame. The server checks both assets against the
workspace/shared-library scope before reserving a credit. No client-provided
storage keys or URLs are accepted. Panoramas are excluded from this path.

The durable generation row stores the shot recipe and resolved frame sources
alongside the existing credit and spend reservation. The worker decodes one
portrait JPEG per source with bounded ffmpeg processes and short-lived signed
URLs. It sends the starting JPEG as `image` and the landing JPEG as `lastFrame`.
[Google documents first/last-frame support for Veo 3.1 Fast](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/video/generate-videos-from-first-and-last-frames).

All paid request settings remain fixed: one silent eight-second 1080p portrait
clip, one credit. A bridge plays the complete generated move at 2x (four
seconds); a burst at 4x (two seconds). Retaining the whole move preserves both
endpoints. Gimbal/drone replacements keep the still's duration and clip ID;
stills over 32 seconds require trimming first. Continuations use four seconds;
custom shots retain eight seconds. All generated media remains reusable in the
library.

## Placement and background completion

Placement compares canonical source-clip snapshots, including their trims and
effects, and requires bridge clips to remain adjacent. Changed boundaries do
not silently receive an insert. A deterministic insert ID prevents repeated
application. Subsequent captions shift with inserted footage; a replacement
keeps the cover and timing. Music remains on the original continuous track.

An optional "Automatically make a separate promo draft" saves the source reel
before queuing. On completion the worker reads the latest saved source reel,
checks the boundary snapshots, and creates a separate private reel with the
assembled edit, caption and music. It never updates the original reel or copies
sharing/publishing consent. The asset, success state and draft commit in the
same fenced transaction; a retry uses the same deterministic draft ID. Missing
or changed sources leave the successful clip in the media library for review.

Frame decoding failures occur before paid submission and refund both credit
and spend reservation. Unknown paid submissions retain the conservative spend
reservation and are never resubmitted. The worker lease allows two bounded
frame extractions plus the provider submission timeout.

## Limits and validation

References currently use source pixels centre-cropped to 9:16. Preview
renditions, letterboxing, Ken Burns motion and differing looks at a join can
still produce visible differences. AI geometry and invented details require
review; the interface does not promise a pixel-perfect join. Drone presets
request a modest rise from exterior photos rather than inventing a large
aerial environment. A draft is editable and is not automatically exported or
posted.

Checks cover trimmed/sped-up boundaries, actual two-image provider payloads,
full-endpoint burst timing, still replacement, caption shifts, changed-source
rejection, duplicate placement, lease fencing and private draft assembly.
