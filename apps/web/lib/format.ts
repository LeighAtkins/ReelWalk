// Australian order and spelling: "4 Oct, 07:08 UTC", "4 Oct".
const dateTime = new Intl.DateTimeFormat("en-AU", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

/** "4 Oct, 07:08 UTC". Fixed to UTC so server-rendered times do not depend on the pod's timezone. */
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

const shortDate = new Intl.DateTimeFormat("en-AU", { month: "short", day: "numeric", timeZone: "UTC" });

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then "4 Oct". */
export function formatAgo(date: Date, now: Date = new Date()): string {
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return shortDate.format(date);
}

