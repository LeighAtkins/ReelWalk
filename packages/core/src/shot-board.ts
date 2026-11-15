import { retimeTexts } from "./text-timing";
import { z } from "zod";
import { removeClip, type Clip, type Timeline } from "./timeline";

/** A saved two-frame operation is independent of editable choices and playable clips. */
export const shotFramePairSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), sourceAssetId: z.string().min(1).max(128),
  startRequestId: z.string().uuid(), endRequestId: z.string().uuid(),
  input: z.string().min(1).max(6000), requestedAt: z.string().datetime(),
  startJobId: z.string().max(128).optional(), endJobId: z.string().max(128).optional(),
  startAssetId: z.string().max(128).optional(), endAssetId: z.string().max(128).optional(),
}).refine(pair => pair.startRequestId !== pair.endRequestId, "Start and End requests must be distinct");
export type ShotFramePair = z.infer<typeof shotFramePairSchema>;

export const shotCardSchema = z.object({
  id: z.string().min(1).max(128),
  sourceAssetId: z.string().min(1).optional(),
  clipId: z.string().min(1).optional(),
  draft: z.string().max(16000).optional(),
  frameAssetIds: z.array(z.string().min(1)).max(4).optional(),
  framePair: shotFramePairSchema.optional(),
  recovery: z.record(z.string().max(300), z.string().max(16000)).refine(value => Object.keys(value).length <= 4).optional(),
  request: z.object({ id: z.string().min(1).max(128), draft: z.string().max(16000), payload: z.string().max(16000).optional(), jobId: z.string().max(128).optional() }).optional(),
});
export const shotBoardSchema = z.object({ version: z.literal(1), cards: z.array(shotCardSchema).max(100) })
  .refine(board => new Set(board.cards.map(card => card.id)).size === board.cards.length, "Shot IDs must be unique")
  .refine(board => { const ids = board.cards.flatMap(card => card.clipId ? [card.clipId] : []); return new Set(ids).size === ids.length; }, "A clip can occupy only one card");
export type ShotCard = z.infer<typeof shotCardSchema>;

/** Reconcile edits from the existing timeline tools without manufacturing playable placeholders. */
export function shotCards(timeline: Timeline): ShotCard[] {
  const clips = new Set(timeline.clips.map(clip => clip.id));
  const cards = (timeline.shotBoard?.cards ?? []).filter(card => !card.clipId || clips.has(card.clipId));
  const linked = new Set(cards.map(card => card.clipId));
  // Completed cards follow the actual cut order; empty reservations keep their positions.
  const ordered = timeline.clips.filter(clip => linked.has(clip.id));
  let at = 0;
  const reconciled = cards.map(card => {
    if (!card.clipId) return card;
    const clip = ordered[at++];
    return cards.find(item => item.clipId === clip.id)!;
  });
  return [...reconciled, ...timeline.clips.filter(clip => !linked.has(clip.id)).map(clip => ({ id: `clip-${clip.id}`, clipId: clip.id }))];
}
export function saveShotCards(timeline: Timeline, cards: ShotCard[]): Timeline {
  return { ...timeline, shotBoard: shotBoardSchema.parse({ version: 1, cards }) };
}
export function updateShotCard(timeline: Timeline, id: string, update: (card: ShotCard) => ShotCard): Timeline {
  const cards = shotCards(timeline);
  if (!cards.some(card => card.id === id)) return timeline;
  const next = cards.map(card => card.id === id ? update(card) : card);
  return JSON.stringify(cards) === JSON.stringify(next) ? timeline : saveShotCards(timeline, next);
}
export function insertShotCard(timeline: Timeline, id: string, before?: string): Timeline {
  const cards = shotCards(timeline);
  if (cards.some(card => card.id === id) || cards.length >= 100) return timeline;
  const index = before === undefined ? cards.length : cards.findIndex(card => card.id === before);
  if (index < 0) return timeline;
  cards.splice(index, 0, { id });
  return saveShotCards(timeline, cards);
}
export function moveShotCard(timeline: Timeline, id: string, offset: number): Timeline {
  const cards = shotCards(timeline), from = cards.findIndex(card => card.id === id);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= cards.length) return timeline;
  const [card] = cards.splice(from, 1); cards.splice(to, 0, card);
  const order = cards.flatMap(item => item.clipId ? [timeline.clips.find(clip => clip.id === item.clipId)!] : []);
  return saveShotCards(retimeTexts(timeline, { ...timeline, clips: order }), cards);
}
export function removeShotCard(timeline: Timeline, id: string): Timeline {
  const cards = shotCards(timeline), card = cards.find(item => item.id === id);
  if (!card) return timeline;
  return saveShotCards(card.clipId ? retimeTexts(timeline, removeClip(timeline, card.clipId)) : timeline, cards.filter(item => item.id !== id));
}
/** Only a take associated with this exact saved draft can occupy its reservation. No append fallback. */
export function placeShotTake(timeline: Timeline, id: string, jobId: string, clip: Clip): Timeline {
  const cards = shotCards(timeline), index = cards.findIndex(card => card.id === id), card = cards[index];
  if (!card || card.clipId || !card.request || card.request.jobId !== jobId || card.request.draft !== card.draft || timeline.clips.some(item => item.id === clip.id)) return timeline;
  return placeShotAsset(timeline, id, clip);
}
/** Explicit library choice uses the current card ID and has no source-anchor fallback. */
export function placeShotAsset(timeline: Timeline, id: string, clip: Clip): Timeline {
  const cards = shotCards(timeline), index = cards.findIndex(card => card.id === id), card = cards[index];
  if (!card || card.clipId || timeline.clips.some(item => item.id === clip.id)) return timeline;
  const at = cards.slice(0, index).filter(item => item.clipId).length;
  const clips = [...timeline.clips]; clips.splice(at, 0, clip);
  return saveShotCards(retimeTexts(timeline, { ...timeline, clips }), cards.map(item => item.id === id ? { ...item, clipId: clip.id } : item));
}
