import { draftHookLines, draftScriptLines, hasDetails, parseTimeline, SCRIPT_LINE_MAX, SCRIPT_MAX_LINES } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { getSessionUser } from "@/lib/auth";
import { instagramSongs } from "@/lib/instagram-songs";
import { isAiConfigured, structuredAnswer } from "@/lib/openai";

export const dynamic = "force-dynamic";

const CAPTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["caption"],
  properties: { caption: { type: "string" } },
} as const;

const SCRIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lines"],
  properties: { lines: { type: "array", items: { type: "string" }, description: "One per take, in playing order" } },
} as const;

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
  const reel = await prisma.reel.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { id: true, title: true, timeline: true, caption: true } });
  if (!reel) return Response.json({ ok: false, message: "This reel was deleted." }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { kind?: unknown; text?: unknown; currentAudioId?: unknown; page?: unknown; count?: unknown; rooms?: unknown; titles?: unknown };

  if (body.kind === "script") {
    // The presenter's lines for Script mode (ADR 0060), from the rooms and titles on the reel as the editor has it now.
    const strings = (value: unknown) => (Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 60)).slice(0, 12);
    const count = typeof body.count === "number" ? Math.max(1, Math.min(SCRIPT_MAX_LINES, Math.round(body.count))) : 3;
    const rooms = strings(body.rooms), titles = strings(body.titles);
    if (!isAiConfigured()) return Response.json({ ok: true, lines: draftScriptLines(rooms, reel.title, count) });
    try {
      const answer = await structuredAnswer({
        instructions:
          `You write what an on-camera presenter says in a vertical real-estate listing reel. Write exactly ${count} lines, one per take, in the order they play: the first opens the reel and greets the viewer, the last closes it with a call to action (a private tour, a message), any between talk about the rooms named. Each line is something a person says aloud in one breath: 4 to 14 words, warm and plain, first person, no hashtags, no emoji, no prices, addresses or sizes unless they appear in the titles. Use only rooms and facts given.`,
        input: `Reel "${reel.title}". Rooms in order: ${rooms.join(", ") || "unknown"}. Titles on the reel: ${titles.length ? titles.map((title) => `"${title}"`).join(", ") : "none"}.`,
        schemaName: "presenter_script",
        schema: SCRIPT_SCHEMA as unknown as Record<string, unknown>,
        maxOutputTokens: 500,
      });
      const lines = (((answer.json as { lines?: unknown }).lines ?? []) as unknown[])
        .filter((line): line is string => typeof line === "string" && line.trim().length >= 3)
        .map((line) => line.trim().slice(0, SCRIPT_LINE_MAX))
        .slice(0, count);
      return lines.length ? Response.json({ ok: true, lines }) : Response.json({ ok: false, message: "No lines came back. Try again." });
    } catch {
      return Response.json({ ok: false, message: "No lines came back. Try again." });
    }
  }

  if (body.kind === "hooks") {
    // Hook lines for the opening (ADR 0068), on the same text path as the presenter's script: the reel's subject
    // from its title, rooms, titles and facts. With no model configured, plain drafts.
    const strings = (value: unknown) => (Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 60)).slice(0, 12);
    const count = typeof body.count === "number" ? Math.max(1, Math.min(8, Math.round(body.count))) : 5;
    let rooms = strings(body.rooms), titles = strings(body.titles);
    let facts = "";
    let price: string | null = null, address: string | null = null;
    try {
      const timeline = parseTimeline(reel.timeline);
      if (!rooms.length) rooms = [...new Set(timeline.clips.map((clip) => clip.room).filter((room): room is string => Boolean(room)))];
      if (!titles.length) titles = timeline.texts.filter((text) => !text.id.startsWith("room-") && !text.id.startsWith("hook-")).map((text) => text.text).slice(0, 12);
      if (hasDetails(timeline.details)) {
        const details = timeline.details;
        price = details.price || null;
        address = details.address || null;
        facts = (["price", "beds", "baths", "area", "address"] as const).filter((key) => details[key]).map((key) => `${key}: ${details[key]}`).join("; ");
      }
    } catch {
      // A reel whose edit cannot be read still gets lines from its title.
    }
    const subject = { title: reel.title, rooms, titles, price, address };
    if (!isAiConfigured()) return Response.json({ ok: true, lines: draftHookLines(subject, count) });
    try {
      const answer = await structuredAnswer({
        instructions:
          `You write the opening line of vertical real-estate reels: the words on screen in the first second that stop a thumb. Write exactly ${count} different hook lines for this reel. Each is 3 to 8 words, plain and specific, one of: a question the viewer answers for themselves, a promise of what they will see if they stay, a surprising fact from the facts given, or a pattern interrupt ("Nobody shows you this room"). No hashtags, no emoji, no exclamation marks, no clickbait that the reel cannot pay off, no prices, addresses or sizes unless they appear in the facts. Use only rooms and facts given.`,
        input: `Reel "${reel.title}". Rooms shown: ${rooms.join(", ") || "unknown"}. Text on the reel: ${titles.length ? titles.map((title) => `"${title}"`).join(", ") : "none"}. Facts: ${facts || "none given"}.`,
        schemaName: "hook_lines",
        schema: SCRIPT_SCHEMA as unknown as Record<string, unknown>,
        maxOutputTokens: 400,
      });
      const lines = (((answer.json as { lines?: unknown }).lines ?? []) as unknown[])
        .filter((line): line is string => typeof line === "string" && line.trim().length >= 3)
        .map((line) => line.trim().replace(/\s+/g, " ").slice(0, 80))
        .slice(0, count);
      return lines.length ? Response.json({ ok: true, lines }) : Response.json({ ok: false, message: "No hooks came back. Try again." });
    } catch {
      return Response.json({ ok: false, message: "No hooks came back. Try again." });
    }
  }

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
  if (body.kind === "caption") {
    // The post text from what the reel knows: its facts, its own lines, its rooms.
    let facts = "";
    let lines: string[] = [];
    let rooms: string[] = [];
    try {
      const timeline = parseTimeline(reel.timeline);
      const details = timeline.details;
      if (hasDetails(details)) {
        facts = (["price", "beds", "baths", "area", "address", "contact"] as const).filter((key) => details[key]).map((key) => `${key}: ${details[key]}`).join("; ");
      }
      lines = timeline.texts.filter((text) => !text.id.startsWith("room-")).map((text) => text.text);
      rooms = [...new Set(timeline.clips.map((clip) => clip.room).filter((room): room is string => Boolean(room)))];
    } catch {
      // A reel whose edit cannot be read still gets a caption from its title.
    }
    if (!isAiConfigured()) {
      const caption = `${facts ? facts.replace(/\w+: /g, "").replace(/; /g, " · ") : reel.title}\nDM for a private tour.\n\n#realestate #justlisted #housetour #dreamhome #newlisting`;
      return Response.json({ ok: true, caption });
    }
    try {
      const answer = await structuredAnswer({
        instructions:
          "You write Instagram captions for real-estate listing reels, in the voice of the listing agent. Two to four short lines: a hook, the facts given (never invented ones: no price, address or size unless given), a call to action (DM, link in bio, open house), then one line of at most five hashtags, #realestate among them and the city's or area's when the address says where. Plain words, no emoji, no markdown. Under 400 characters.",
        input: `Reel "${reel.title}". Facts: ${facts || "none given"}. Text on the reel: ${lines.length ? lines.map((line) => `"${line}"`).join(", ") : "none"}. Rooms shown: ${rooms.join(", ") || "unknown"}.${reel.caption ? ` The current caption, to improve on: "${reel.caption.slice(0, 600)}"` : ""}`,
        schemaName: "caption",
        schema: CAPTION_SCHEMA as unknown as Record<string, unknown>,
        maxOutputTokens: 500,
      });
      const caption = (answer.json as { caption?: unknown }).caption;
      if (typeof caption !== "string" || !caption.trim()) return Response.json({ ok: false, message: "No caption came back. Try again." });
      return Response.json({ ok: true, caption: caption.trim().slice(0, 2200) });
    } catch {
      return Response.json({ ok: false, message: "No caption came back. Try again." });
    }
  }
  return Response.json({ ok: false, message: "Unknown request." }, { status: 400 });
}
