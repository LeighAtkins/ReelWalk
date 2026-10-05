const dateTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

/** "Oct 4, 07:08 UTC". Fixed to UTC so server-rendered times do not depend on the pod's timezone. */
export function formatDateTime(date: Date): string {
  return `${dateTime.format(date)} UTC`;
}

/** "0:07" for lists; "0:07.4" with tenths for the editor's timecode. */
export function formatDuration(ms: number, tenths = false): string {
  const totalTenths = Math.max(0, Math.floor(ms / 100));
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const base = `${minutes}:${String(seconds).padStart(2, "0")}`;
  return tenths ? `${base}.${totalTenths % 10}` : base;
}
