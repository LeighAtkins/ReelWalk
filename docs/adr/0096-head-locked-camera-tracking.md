# 0096 — Lock on head

Date: 2026-10-30

The owner asked for CapCut-style camera tracking using a bouncing Maya take. ReelWalk's surface and face trackers already placed titles on moving subjects, but neither stabilised the picture around a head. ADR 0086's proposed reframe API is not present on main.

Add **Lock on head** under a clip's **Zoom & tracking** sheet. Select the face on the first played frame, adjust the box, then Track head. It reads the original source at 24 fps and uses the existing pyramidal optical-flow face tracker. This also works on uploaded video without an AI identity record. Analysis stays in the browser and costs no AI credits. Limit the source section to 12 seconds to bound decoder and frame memory. Closing the picker cancels pending work; a result never applies after the picker has unmounted.

`clip.headLock` stores versioned source-time samples, a fixed target position, reference face height and a single crop reserve. Symmetric position smoothing removes jitter without causal lag; stronger size smoothing reduces bounding-box noise. Each frame compensates translation and apparent face height. Compute the crop reserve over the whole measured section, with a small safety margin, so no unfilled border appears. Refuse tracks with gaps, lost faces, a head outside the original vertical crop, or a required crop above 3×. This first version fills the frame by cropping; it has no generative or blurred edge fill and no rotation lock.

`setHeadLock` is one document command and one undo step. It validates video kind and time coverage, switches to Fill, clears the previous move and resets extra zoom. Remove head tracking restores the untracked picture; previous camera settings are recoverable with Undo. Existing reels have no headLock and render identically. No database migration or dependency is needed.

The shared `clipCameraAt` and `clipPicture` geometry evaluate the lock in source time, including trim, playback speed and ramps. The editor Player, final Remotion renderer, person matte and frame-service canvas use that geometry. Extra zoom keeps the head's anchor. Stored samples survive splitting and trimming inside the tracked interval. Extending beyond it requires a fresh track.

Validation covers fixed head position and scale, filled boundaries between samples, speed/trim source-time mapping, invalid and incomplete tracks, old timeline parsing and command apply/remove. The Maya proof, UI capture, measured crop and QC results are recorded with the PR. This is a deterministic camera crop, not video resynthesis: source motion blur, facial changes and occlusion cannot be repaired by the effect.
