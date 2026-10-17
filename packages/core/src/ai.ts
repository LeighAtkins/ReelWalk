export const AI_CLIP_SECONDS = 8;
export const AI_CLIP_COST_CENTS = 80;
export const AI_VIDEO_MODEL = "veo-3.1-fast-generate-001";

export const AI_PLAN_CREDITS = { FREE: 1, AGENT: 10, OFFICE: 30 } as const;
export const AI_TOP_UP = { priceCents: 1500, credits: 5 } as const;

/** Monthly windows stay anchored to the subscription day, including Jan 31. */
export function aiCreditWindow(anchor: Date, paidThrough: Date, now = new Date()): { start: Date; end: Date } | null {
  if (now < anchor || now >= paidThrough) return null;
  const atMonth = (offset: number) => {
    const date = new Date(anchor);
    date.setUTCDate(1);
    date.setUTCMonth(anchor.getUTCMonth() + offset);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(anchor.getUTCDate(), lastDay));
    return date;
  };
  let offset = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + now.getUTCMonth() - anchor.getUTCMonth();
  if (atMonth(offset) > now) offset -= 1;
  return { start: atMonth(offset), end: new Date(Math.min(atMonth(offset + 1).getTime(), paidThrough.getTime())) };
}
