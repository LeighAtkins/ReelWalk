import { Prisma, prisma } from "@reelwalk/db";
import { readAttribution, type Attribution } from "./attribution";

/**
 * First-party funnel events (ADR 0080): what a sign-up, a first export, a
 * started checkout and a paid subscription look like on our own server. They
 * are the base any ad platform's pixel or Conversions API call is built from
 * later; nothing here talks to a third party.
 */
export const FUNNEL_EVENTS = ["signup", "first_export", "checkout_started", "subscribed"] as const;
export type FunnelEventName = (typeof FUNNEL_EVENTS)[number];

type EventData = Record<string, string | number | boolean | null>;

/**
 * Writes one event. It never throws: a counting failure must not fail a
 * sign-up or a payment. `key` makes an event that happens once per thing
 * (the first export of a studio, one subscription) idempotent; a second
 * attempt with the same key is silently dropped.
 */
export async function recordFunnelEvent(event: {
  name: FunnelEventName;
  userId?: string | null;
  workspaceId?: string | null;
  key?: string;
  data?: EventData;
}): Promise<void> {
  try {
    const owner = event.userId ?? (event.workspaceId ? await firstUserOf(event.workspaceId) : null);
    const attribution = owner ? readAttribution((await prisma.user.findUnique({ where: { id: owner }, select: { attribution: true } }))?.attribution) : null;
    await prisma.funnelEvent.create({
      data: {
        name: event.name,
        userId: owner,
        workspaceId: event.workspaceId ?? null,
        eventKey: event.key ?? null,
        data: { ...(attribution ?? {}), ...(event.data ?? {}) } as Prisma.InputJsonObject,
      },
    });
  } catch (error) {
    // A repeated key is the point of the key; anything else is worth a log line but not a failed request.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return;
    console.error(`funnel: could not record ${event.name}`, error);
  }
}

async function firstUserOf(workspaceId: string): Promise<string | null> {
  const user = await prisma.user.findFirst({ where: { workspaceId }, orderBy: { createdAt: "asc" }, select: { id: true } });
  return user?.id ?? null;
}

export type FunnelRow = { source: string; campaign: string; counts: Record<FunnelEventName, number> };

/** Events since `since`, counted per utm_source and utm_campaign ("(none)" when the visitor came without). For /api/admin/funnel. */
export async function funnelSummary(since: Date): Promise<{ total: Record<FunnelEventName, number>; rows: FunnelRow[] }> {
  const events = await prisma.funnelEvent.findMany({ where: { createdAt: { gte: since } }, select: { name: true, data: true } });
  const empty = (): Record<FunnelEventName, number> => ({ signup: 0, first_export: 0, checkout_started: 0, subscribed: 0 });
  const total = empty();
  const rows = new Map<string, FunnelRow>();
  for (const event of events) {
    if (!(FUNNEL_EVENTS as readonly string[]).includes(event.name)) continue;
    const name = event.name as FunnelEventName;
    const attribution: Attribution = readAttribution(event.data) ?? {};
    const source = attribution.utm_source ?? (attribution.fbclid ? "facebook (fbclid)" : attribution.gclid ? "google (gclid)" : "(none)");
    const campaign = attribution.utm_campaign ?? "(none)";
    const key = `${source}\u0000${campaign}`;
    const row = rows.get(key) ?? { source, campaign, counts: empty() };
    row.counts[name] += 1;
    total[name] += 1;
    rows.set(key, row);
  }
  return { total, rows: [...rows.values()].sort((a, b) => b.counts.signup - a.counts.signup || b.counts.subscribed - a.counts.subscribed) };
}
