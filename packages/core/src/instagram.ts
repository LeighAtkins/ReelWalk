import { REEL_FORMAT, timelineDurationMs, type Timeline } from "./timeline";

/**
 * Instagram Reels limits the export is checked against. Instagram changes
 * these from time to time; they are kept in one place for that reason.
 */
export const INSTAGRAM = {
  minDurationMs: 3_000,
  maxDurationMs: 3 * 60_000,
  captionMaxChars: 2_200,
  maxHashtags: 30,
  /**
   * Areas Instagram covers with its own UI on a 1080x1920 frame: the header
   * at the top, caption and audio label at the bottom, the like/comment/share
   * buttons on the right. Text placed there is likely to be hidden.
   */
  safeZonePx: { top: 250, bottom: 500, left: 60, right: 120 },
} as const;

/** The safe area as fractions of the frame, for drawing guides and checking positions. */
export const SAFE_AREA = {
  top: INSTAGRAM.safeZonePx.top / REEL_FORMAT.height,
  bottom: 1 - INSTAGRAM.safeZonePx.bottom / REEL_FORMAT.height,
  left: INSTAGRAM.safeZonePx.left / REEL_FORMAT.width,
  right: 1 - INSTAGRAM.safeZonePx.right / REEL_FORMAT.width,
} as const;

export function isInSafeArea(x: number, y: number): boolean {
  return x >= SAFE_AREA.left && x <= SAFE_AREA.right && y >= SAFE_AREA.top && y <= SAFE_AREA.bottom;
}

export function countHashtags(caption: string): number {
  return caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu)?.length ?? 0;
}

export type Issue = {
  level: "error" | "warning";
  code: "empty" | "too-short" | "too-long" | "text-unsafe" | "caption-too-long" | "too-many-hashtags";
  message: string;
  /** The text overlay the issue is about, if any. */
  textId?: string;
};

function seconds(value: number): string {
  return `${Math.round(value / 100) / 10}s`;
}

/** Errors block export; warnings are shown but do not. */
export function instagramIssues(timeline: Timeline, caption = ""): Issue[] {
  const issues: Issue[] = [];
  const duration = timelineDurationMs(timeline);

  if (timeline.clips.length === 0) {
    issues.push({ level: "error", code: "empty", message: "Add at least one photo or video." });
  } else if (duration < INSTAGRAM.minDurationMs) {
    issues.push({
      level: "error",
      code: "too-short",
      message: `Reels must be at least ${seconds(INSTAGRAM.minDurationMs)}. This one is ${seconds(duration)}.`,
    });
  } else if (duration > INSTAGRAM.maxDurationMs) {
    issues.push({
      level: "error",
      code: "too-long",
      message: `Reels can be up to 3 minutes. This one is ${seconds(duration)}.`,
    });
  }

  for (const text of timeline.texts) {
    if (!isInSafeArea(text.x, text.y)) {
      issues.push({
        level: "warning",
        code: "text-unsafe",
        message: `"${text.text.slice(0, 24)}" sits where Instagram's buttons or caption may cover it.`,
        textId: text.id,
      });
    }
  }

  if (caption.length > INSTAGRAM.captionMaxChars) {
    issues.push({
      level: "error",
      code: "caption-too-long",
      message: `Captions can be ${INSTAGRAM.captionMaxChars} characters. This one is ${caption.length}.`,
    });
  }
  const hashtags = countHashtags(caption);
  if (hashtags > INSTAGRAM.maxHashtags) {
    issues.push({
      level: "error",
      code: "too-many-hashtags",
      message: `Instagram allows ${INSTAGRAM.maxHashtags} hashtags. This caption has ${hashtags}.`,
    });
  }
  return issues;
}

export function canExport(issues: Issue[]): boolean {
  return !issues.some((issue) => issue.level === "error");
}
