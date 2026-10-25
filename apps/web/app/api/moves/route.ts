import { AI_DRAFT_CREDITS, AI_DRAFT_MODEL, MOVES, MOVE_GROUP_LABELS, aiDraftCostCents, movePrompt } from "@reelwalk/core";

export const runtime = "nodejs";

/**
 * The camera-move library (ADR 0076), for the agents that build reels over HTTP: every move's id, whether it can be applied to
 * footage already shot (`applyMove`, over POST /api/reels/:id/commands) or only asked of Veo (`move` on POST
 * /api/ai/generations), and the prompt Veo is given. Static data, nothing about any workspace.
 */
export function GET() {
  return Response.json({
    moves: MOVES.map((move) => ({
      id: move.id, label: move.label, group: move.group, groupLabel: MOVE_GROUP_LABELS[move.group], blurb: move.blurb,
      aiOnly: move.real === null, aiOnlyBecause: move.aiOnly ?? null,
      real: move.real ? { camera: move.real.camera === undefined ? "unchanged" : move.real.camera === null ? "cleared" : typeof move.real.camera === "string" ? move.real.camera : "keys",
        speedRamp: move.real.ramp ?? null, zoomBlurIntoClip: move.real.cutIn ?? null, zoomBlurIntoNextClip: move.real.cutOut ?? null } : null,
      ai: { lens: move.ai.lens, hands: move.ai.hands, seconds: move.ai.seconds, best: move.ai.best, prompt: movePrompt(move.id) },
    })),
    draft: { model: AI_DRAFT_MODEL, credits: AI_DRAFT_CREDITS, reservedCentsPerSecond: aiDraftCostCents(4) / 4 },
  }, { headers: { "Cache-Control": "public, max-age=300" } });
}
