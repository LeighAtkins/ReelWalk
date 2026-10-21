/**
 * "Use this frame" for a passing title (ADR 0055): the crossing is read from the playhead when the button is
 * pressed, not when the sheet opened, so a reel still playing behind the sheet sets the frame that is on screen.
 */
export function crossingNow(playheadNow: () => number): number {
  return Math.max(0, Math.round(playheadNow()));
}
