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

export function countOf(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
