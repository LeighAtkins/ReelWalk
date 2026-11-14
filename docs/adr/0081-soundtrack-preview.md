# ADR 0081: One soundtrack preview before publishing

Status: proposed (2026-10-25)

## Context

A posted reel used a creator sound labelled as solo piano whose opening contained unwanted speech. The soundtrack name was not evidence of its contents. Export video controls played the export alone, while the attached Instagram sound required a separate, less obvious player. The audio trace also offered an independent player with recommended volumes, which could differ from the volumes selected for publishing.

## Decision

The export stage owns one audio element and one transport. The selected posting sound is registered by InstagramPublishing; scheduled comparisons register their draft sound. Native video Play, Pause, seek, speed and the explicit preview buttons all operate that transport. Changing a sound disposes the previous transport, cancels pending work and pauses both media. Loading/playback failures pause both and show an error rather than playing the export with an incorrect or absent soundtrack. Playback requires a user gesture; exports no longer autoplay a misleading silent video. Removing the attached sound restores normal export playback.

The picker exposes the supplied audio preview with native controls, including seeking. It warns that creator sounds can contain speech. The chosen mix is the only mix played; audio-trace recommendations remain advice, not a second player silently using different levels. The downloaded MP4 still contains the original export audio.

### Start point limitation

Meta's current [Instagram Audio API](https://developers.facebook.com/documentation/instagram-platform/content-publishing/audio-api), checked on 2026-10-25, documents only audio_id, audio_volume and video_volume in audio_configuration. It provides no supported start-offset parameter or server-side mixed-reel preview. ReelWalk must not offer a shifted Instagram preview as if that segment will automatically publish. The UI states that auto-posting starts at 0:00, and directs users needing a later segment to finish in Instagram or use their own music. The editor's existing Music → Adjust → Start the song at changes sourceStartMs for ordinary music in both preview and export. No copyrighted Instagram preview is baked into an export.

### Agent access

No publishing protocol changes. Existing post/schedule APIs still take the chosen sound ID and both volumes; no unsupported offset is invented. A soundtrack label, catalogue metadata, waveform or successful API call is not a listening check. Before publishing, review the supplied audio throughout the reel's full duration; if its contents cannot be verified, leave the reel as a draft. An Instagram-supplied preview remains a preview, not proof of the exact final server mix.

## Validation

- Focused transport tests cover native Play, volumes, pause, seek, playback speed, shorter sounds, replay, failed playback, media errors and disposal during a pending sound load.
- Updated the existing Instagram-sound E2E scenario to cover native video playback and audition controls without weakening its export, selection or scheduling checks.
- Full pnpm check passed locally; environment-dependent database/provider tests remained skipped as configured.
- Browser QA uses the actual React components with local fixture video/audio and a stub playback action; production Instagram publishing is not exercised by that fixture. Results are recorded in the PR.

## Consequences

Preview failures are conspicuous. Full sound audition is possible before publishing, but preview availability and Instagram's publishing limitations remain external constraints. Changing an Instagram sound's start point for automatic posting remains unsupported; this change deliberately does not pretend otherwise. Existing scheduled rows and render payloads are unchanged; no migration is needed.
