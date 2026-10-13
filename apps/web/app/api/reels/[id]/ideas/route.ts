import { prisma } from "@reelwalk/db";
import { getSessionUser } from "@/lib/auth";
import { instagramSongs } from "@/lib/instagram-songs";
import { isAiConfigured, structuredAnswer } from "@/lib/openai";

export const dynamic = "force-dynamic";

const TEXT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["options"],
  properties: { options: { type: "array", items: { type: "string" }, description: "Exactly three" } },
} as const;

/**
 * Three ideas for one quick change in the draft review (ADR 0022).
 * kind "text": three rewordings of one line of the reel's text, same length or
 * shorter, in the same voice. kind "music": three Instagram songs of different
 * moods from the library searches that suit listings, skipping the current one;
 * "page" moves on to three more.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, message: "Cross-site request refused." }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  const { id } = await params;
  const reel = await prisma.reel.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { id: true, title: true } });
  if (!reel) return Response.json({ ok: false, message: "This reel was deleted." }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { kind?: unknown; text?: unknown; currentAudioId?: unknown; page?: unknown };

  if (body.kind === "music") {
    const songs = await instagramSongs(user.workspaceId, 6);
    if (songs.length === 0) return Response.json({ ok: false, message: "Connect Instagram on the Account tab to choose from its music." });
    // One song per mood first, so the three differ; later pages go deeper into each mood.
    const byMood = new Map<string, typeof songs>();
    for (const song of songs) {
      if (song.instagram?.id === body.currentAudioId) continue;
      byMood.set(song.mood ?? "", [...(byMood.get(song.mood ?? "") ?? []), song]);
    }
    const order: typeof songs = [];
    for (let depth = 0; order.length < songs.length && depth < 6; depth++) for (const list of byMood.values()) if (list[depth]) order.push(list[depth]);
    const page = typeof body.page === "number" && body.page > 0 ? Math.floor(body.page) : 0;
    const picks = order.slice(page * 3, page * 3 + 3);
    return Response.json({ ok: true, music: picks.map((song) => ({ track: song.instagram, mood: song.mood })) });
  }

  if (body.kind === "text") {
    const text = typeof body.text === "string" ? body.text.trim().slice(0, 200) : "";
    if (!text) return Response.json({ ok: false, message: "Pick a line of text first." }, { status: 400 });
    if (!isAiConfigured()) return Response.json({ ok: true, options: [text.toUpperCase(), text.toLowerCase(), text] });
    try {
      const answer = await structuredAnswer({
        instructions:
          "You write the short on-screen text for vertical real-estate listing reels. Given one line from a reel, offer exactly three alternatives: same meaning, the same length or shorter, plain words a buyer would stop for, no hashtags, no emoji. Keep any facts (prices, addresses, times) exactly as given. If the line has a line break, the alternatives may use one too.",
        input: `The reel is "${reel.title}". The line: ${text}`,
        schemaName: "text_options",
        schema: TEXT_SCHEMA as unknown as Record<string, unknown>,
        maxOutputTokens: 400,
      });
      const options = ((answer.json as { options?: unknown }).options ?? []) as unknown[];
      return Response.json({ ok: true, options: options.filter((option): option is string => typeof option === "string" && option.trim().length > 0).slice(0, 3) });
    } catch {
      return Response.json({ ok: false, message: "No ideas came back. Try again." });
    }
  }
  return Response.json({ ok: false, message: "Unknown request." }, { status: 400 });
}
