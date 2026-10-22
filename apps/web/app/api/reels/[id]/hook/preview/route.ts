import { HOOK_PATTERNS, hookRules, openingMoments, planHook, type HookPattern } from "@reelwalk/core";
import { getSessionUser } from "@/lib/auth";
import { hookInputsFromLibrary, loadReel } from "@/lib/reel-command";

export const dynamic = "force-dynamic";

/**
 * The opening under a hook pattern, without saving anything (ADR 0068):
 * `GET /api/reels/:id/hook/preview?pattern=voice-in&title=…&promise=…&clipId=…`
 * (no `pattern`, or `pattern=all`, for every pattern). For each: whether the
 * pattern can be made from this reel and why not, the four moments at 0, 0.5,
 * 1.0 and 1.5 s (the clip, its media URL and source time, and the titles on
 * screen) so an agent can pull those frames with ffmpeg and compare openings,
 * the hook rules on the planned opening, and the planned timeline itself to
 * save or to send as `{ type: "hook" }` through `/commands`.
 *
 * Pixels are not rendered here: the web server has no Remotion renderer or
 * browser. The moments are what the shared composition would show; the
 * editor's Hook studio plays them live from the same plan.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  const { id } = await params;
  const loaded = await loadReel(user, id);
  if (!loaded) return Response.json({ ok: false, message: "This reel was deleted." }, { status: 404 });
  const url = new URL(request.url);
  const wanted = url.searchParams.get("pattern") ?? "all";
  const patterns: HookPattern[] = wanted === "all" ? [...HOOK_PATTERNS] : (HOOK_PATTERNS as readonly string[]).includes(wanted) ? [wanted as HookPattern] : [];
  if (patterns.length === 0) return Response.json({ ok: false, message: `pattern is one of ${HOOK_PATTERNS.join(", ")} or all.` }, { status: 400 });
  const known = hookInputsFromLibrary(loaded.library);
  const titles = url.searchParams.getAll("title").map((title) => title.trim()).filter(Boolean);
  const inputs = { ...known, titles, promise: url.searchParams.get("promise") ?? undefined, clipId: url.searchParams.get("clipId") ?? undefined, headline: loaded.title };
  const previews = patterns.map((pattern) => {
    const plan = planHook(loaded.timeline, pattern, inputs);
    if (!plan) return { pattern, available: false, reason: unavailableReason(pattern), frames: [], rules: [] };
    const frames = openingMoments(plan.timeline).map((moment) => {
      const asset = loaded.library[moment.assetId];
      return {
        atMs: moment.atMs, clipId: moment.clipId, assetId: moment.assetId, sourceMs: moment.sourceMs,
        src: asset?.url ?? null, thumbUrl: asset?.thumbUrl ?? null,
        texts: moment.texts.map((text) => ({ id: text.id, text: text.text, x: text.x, y: text.y, style: text.style, startMs: text.startMs })),
      };
    });
    return { pattern, available: true, note: plan.note, opening: plan.opening, frames, rules: hookRules(plan.timeline, { speech: known.speech }), timeline: plan.timeline };
  });
  return Response.json({ ok: true, revision: loaded.revision, current: loaded.timeline.opening ?? null, previews });
}

function unavailableReason(pattern: HookPattern): string {
  switch (pattern) {
    case "voice-in": return "No shot with speech in it (a transcribed video with its sound on).";
    case "text-punch": return "No hook line: send title=… or name the reel.";
    case "question": return "No question to ask: send title=… or name the reel.";
    case "pattern-interrupt": return "The reel needs a second shot that is not a 360 or a presenter take.";
    case "motion-in": return "The reel has no shot to open on.";
  }
}
