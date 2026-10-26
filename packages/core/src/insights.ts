/**
 * A published reel's numbers as one line for the Scheduled page (ADR 0027):
 * "1,204 views · 980 reached · 3.2 s average watch · 41 likes · 6 comments".
 * Zero counts after views and reach are left out; null means Instagram did
 * not report the metric.
 */
export type InsightNumbers = {
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  saved: number | null;
  shares: number | null;
  avgWatchMs: number | null;
};

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-AU")} ${n === 1 ? one : many}`;

export function insightsLine(i: InsightNumbers): string {
  const parts: string[] = [];
  if (i.views != null) parts.push(count(i.views, "view", "views"));
  if (i.reach != null) parts.push(`${i.reach.toLocaleString("en-AU")} reached`);
  if (i.avgWatchMs != null && i.avgWatchMs > 0) parts.push(`${(i.avgWatchMs / 1000).toFixed(1)} s average watch`);
  if (i.likes) parts.push(count(i.likes, "like", "likes"));
  if (i.comments) parts.push(count(i.comments, "comment", "comments"));
  if (i.saved) parts.push(count(i.saved, "save", "saves"));
  if (i.shares) parts.push(count(i.shares, "share", "shares"));
  return parts.length ? parts.join(" · ") : "No numbers yet";
}
