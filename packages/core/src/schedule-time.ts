/**
 * Wall-clock times for scheduled posts. The form shows a
 * <input type="datetime-local"> in the viewer's own time zone; the server
 * receives that "YYYY-MM-DDTHH:mm" string plus the browser's IANA zone and
 * stores the instant in UTC. Converting on the server (rather than trusting
 * an ISO string from the browser) keeps one tested code path for it.
 */

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** How far the posting window reaches: a little under the life of an Instagram token. */
export const SCHEDULE_MAX_AHEAD_DAYS = 60;
/** A post must be at least this far in the future, so it is not "scheduled" for a moment already past. */
export const SCHEDULE_MIN_LEAD_MS = 2 * 60_000;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The zone's wall-clock fields for an instant. */
function wallClock(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Minutes the zone is ahead of UTC at an instant (Tokyo +540, New York -240 in summer). */
export function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const wall = wallClock(date, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/**
 * "2026-10-13T09:00" in `timeZone` as a UTC instant. Null for a malformed
 * string, an impossible date or an unknown zone.
 *
 * A wall time skipped by a spring-forward change (02:30 on the night clocks
 * jump to 03:00) has no instant; it is moved forward by the gap, the way a
 * phone's clock app treats it. A time that happens twice in the autumn takes
 * the first (daylight) one.
 */
export function zonedLocalToUtc(local: string, timeZone: string): Date | null {
  const match = LOCAL_PATTERN.exec(local);
  if (!match || !isValidTimeZone(timeZone)) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  // Date.UTC rolls 31 February over into March; refuse instead.
  if (new Date(naive).getUTCDate() !== day) return null;

  // The offset at the naive instant is right except within a few hours of a
  // change, so try the offsets at both candidate instants and keep the ones
  // that really show `local`; the earliest wins when the wall time happens twice.
  const offsetA = zoneOffsetMinutes(new Date(naive), timeZone);
  const offsetB = zoneOffsetMinutes(new Date(naive - offsetA * 60_000), timeZone);
  const candidates = [offsetA, offsetB].map((offset) => naive - offset * 60_000);
  const exact = candidates.filter((instant) => toZonedLocal(new Date(instant), timeZone) === local).sort((a, b) => a - b);
  if (exact[0] !== undefined) return new Date(exact[0]);
  // In a gap: shift by the jump (the difference between the two offsets).
  return new Date(naive - Math.min(offsetA, offsetB) * 60_000);
}

/** A UTC instant as the "YYYY-MM-DDTHH:mm" a datetime-local input shows in `timeZone`. */
export function toZonedLocal(date: Date, timeZone: string): string {
  const wall = wallClock(date, timeZone);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

/** Why `publishAt` cannot be scheduled, or null when it can. */
export function publishAtProblem(publishAt: Date, now: Date): string | null {
  if (publishAt.getTime() < now.getTime() + SCHEDULE_MIN_LEAD_MS) return "Pick a time at least a few minutes from now.";
  if (publishAt.getTime() > now.getTime() + SCHEDULE_MAX_AHEAD_DAYS * 86_400_000) {
    return `Posts can be scheduled up to ${SCHEDULE_MAX_AHEAD_DAYS} days ahead.`;
  }
  return null;
}

/**
 * What the schedule form offers first: tomorrow at 09:00 local time, the
 * morning slot the @reelwalking account posts in.
 */
export function defaultScheduleLocal(now: Date, timeZone: string): string {
  const today = toZonedLocal(now, timeZone).slice(0, 10);
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1));
  return `${tomorrow.toISOString().slice(0, 10)}T09:00`;
}
