import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  addClips,
  AI_DRAFT_CREDITS,
  aiClipCostCents,
  aiClipCredits,
  aiDraftCostCents,
  aiFinalCredits,
  aiShotSchema,
  parseStoredAiShot,
  type AiShot,
  COMMAND_TYPES,
  DEFAULT_VOICE,
  VOICES,
  VOICEOVER_MAX_CHARS,
  voiceName,
  type VoiceId,
  describeLockups,
  canExport,
  describeBrandKit,
  clipStartsMs,
  clipDurationMs,
  emptyTimeline,
  groupStock,
  hasSpeech,
  instagramIssues,
  parseTimeline,
  passesStockFilters,
  timelineDurationMs,
  type Command,
  type Spot,
  type StockFilters,
  type Timeline,
} from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { MAX_COMMANDS, inBatch, isCommand } from "../command-types";
import { toLibraryAssets } from "../library";
import { workspaceBrandKit } from "../brand-kit";
import { applyReelCommand, loadReel } from "../reel-command";
import { readTimeline } from "../reels";
import { saveReelFor } from "../save-reel";
import { mediaScope } from "../media-scope";
import { AI_OFF_CODE, AI_OFF_MESSAGE, aiIsOff } from "../ai-gate";
import { listWorkspaces } from "../workspaces";
import { getStyleReference, listStyleReferences } from "../style-references";
import { MINUTE, HOUR } from "./http";
import { clipForAsset } from "./clips";
import type { ActingUser } from "./acting-user";
import type { Scope } from "./scopes";

/**
 * The connector's tools (ADR 0077). Each is data: a name, an LLM-facing
 * description, a zod shape for its input, the scopes it needs and a `run`.
 * `server.ts` registers them on an MCP server; `runTool` checks the scopes
 * and the rate limits first. They call the same library functions the editor
 * and the HTTP routes call, as the connected person (the workspace scoping,
 * plan limits and AI credit gates of those functions are unchanged).
 */

export type ToolContext = { user: ActingUser; scopes: Scope[]; origin: string };
export type ToolResult = CallToolResult;
export type Limit = { key: string; max: number; windowMs: number };

export type ToolSpec = {
  name: string;
  title: string;
  description: string;
  /** Needed on every call. */
  scopes: Scope[];
  input: z.ZodRawShape;
  /** Reads only (true) or changes the account's data (false). */
  readOnly: boolean;
  /** Counted against the person's write limit as well. */
  write?: boolean;
  /** Tool-specific limits, on top of the per-person ones. */
  limits?: (userId: string, args: Record<string, unknown>) => Limit[];
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
};

// ── Results ──────────────────────────────────────────────────────

const ok = (data: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }) }] });
const failure = (message: string, data: Record<string, unknown> = {}): ToolResult => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, message, ...data }) }] });

const reelUrl = (ctx: ToolContext, id: string) => `${ctx.origin}/reels/${id}`;
const NO_REEL = "No reel with that id in this account. Call list_reels for the ids.";

/** House style, repeated in the tools where it matters, so an agent that never reads the server instructions still sees it. */
export const STYLE_HINTS =
  "House style unless the owner says otherwise: no boxed or backgrounded text (use unboxed serif, style 'elegant', with a soft shadow; a workspace with a brand kit, see get_brand_kit, uses the kit's named styles instead, which may have plates and hard shadows); no whoosh sounds (a quiet riser or impact only if clearly under the music); the first cut or visual change inside the first second; hard cuts by default (a dissolve, soft dissolve, focus pull or light leak only when asked, on two cuts at most); a title on screen from frame 0, under seven words, kept above y 0.72 (Instagram's caption zone) and off the centre of the frame.";

export const SERVER_INSTRUCTIONS = [
  "ReelWalk makes short vertical reels (1080x1920, up to 90 s) for property listings and venues. You drive the signed-in person's own account, in the one workspace this connection was bound to when they connected it (list_workspaces names it; it cannot be switched from here).",
  "Typical flow: list_reels or create_reel -> list_media / search_stock / add_media for footage -> get_reel to read the cut -> apply_commands (dryRun first for anything big) -> export_reel -> get_export until SUCCEEDED -> get_frames and get_checks to look at the result -> adjust and export again.",
  "Always read a reel before changing it and pass its revision to apply_commands; if it answers 409 the person edited it meanwhile, so read it again.",
  STYLE_HINTS,
  "If get_reel shows a brandKit, read it with get_brand_kit and style titles with the applyTextStyle command rather than hand-setting fonts and colours.",
  "You cannot post to Instagram or schedule posts from here; tell the person to do that in the app. AI video costs the person's credits: generate_ai_shot quotes first and spends only after confirmCredits matches.",
].join(" ");

// ── Reading ──────────────────────────────────────────────────────

const listWorkspacesTool: ToolSpec = {
  name: "list_workspaces",
  title: "List workspaces",
  description:
    "Which workspace this connection works in, and the person's other workspaces. Every other tool acts in the bound workspace only (its reels, media, brand kit, credits). The connection cannot switch: to work in another workspace the person disconnects the app under Account, Connected apps, and connects it again, choosing that workspace on the consent screen.",
  scopes: ["reels:read"],
  readOnly: true,
  input: {},
  async run(ctx) {
    const all = await listWorkspaces(ctx.user, ctx.user.workspaceId);
    const shape = (workspace: (typeof all)[number]) => ({ id: workspace.id, name: workspace.name, role: workspace.role.toLowerCase(), aiGeneration: workspace.ai });
    return ok({
      workspace: shape(all.find((workspace) => workspace.id === ctx.user.workspaceId) ?? { id: ctx.user.workspaceId, name: ctx.user.workspace.name, slug: ctx.user.workspace.slug, role: ctx.user.role, home: false, active: true, ai: ctx.user.workspace.aiGeneration === "off" ? "off" : "on" }),
      others: all.filter((workspace) => workspace.id !== ctx.user.workspaceId).map(shape),
      note: "This connection is bound to one workspace. Switching means disconnecting and reconnecting the app (Account, Connected apps) and choosing the other workspace.",
    });
  },
};

const listReels: ToolSpec = {
  name: "list_reels",
  title: "List reels",
  description: "List the person's reels, newest edit first: id, title, revision, duration, clip count and whether a render is running. Use the id with get_reel.",
  scopes: ["reels:read"],
  readOnly: true,
  input: {
    limit: z.number().int().min(1).max(50).default(20).describe("How many reels (1-50)."),
    offset: z.number().int().min(0).max(5000).default(0).describe("Skip this many, for paging."),
  },
  async run(ctx, args) {
    const { limit, offset } = args as { limit: number; offset: number };
    const where = { workspaceId: ctx.user.workspaceId };
    const [total, rows] = await Promise.all([
      prisma.reel.count({ where }),
      prisma.reel.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: offset,
        take: limit,
        select: { id: true, title: true, revision: true, caption: true, updatedAt: true, timeline: true, renderJobs: { where: { kind: "REEL" }, orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true } } },
      }),
    ]);
    return ok({
      total,
      reels: rows.map((row) => {
        const timeline = readTimeline(row.timeline);
        return {
          id: row.id,
          title: row.title,
          revision: row.revision,
          durationMs: timelineDurationMs(timeline),
          clipCount: timeline.clips.length,
          updatedAt: row.updatedAt.toISOString(),
          lastExport: row.renderJobs[0] ? { exportId: row.renderJobs[0].id, status: row.renderJobs[0].status } : null,
          url: reelUrl(ctx, row.id),
        };
      }),
    });
  },
};

/** A reel for an LLM: the order of clips with their lengths, the titles, the song, and what would block an export. */
function summarise(timeline: Timeline, library: Record<string, { fileName: string; kind: string; room: string | null; durationMs: number | null }>) {
  const starts = clipStartsMs(timeline);
  return {
    durationMs: timelineDurationMs(timeline),
    clips: timeline.clips.map((clip, index) => ({
      id: clip.id,
      index,
      assetId: clip.assetId,
      fileName: library[clip.assetId]?.fileName ?? null,
      kind: clip.kind,
      room: clip.room,
      startMs: starts[index] ?? 0,
      durationMs: clipDurationMs(clip),
      sourceWindowMs: [clip.sourceStartMs, clip.sourceEndMs],
      speed: clip.speed,
      transitionIn: clip.transitionIn,
      filter: clip.filter,
      motion: clip.motion,
    })),
    texts: timeline.texts.map((text) => ({ id: text.id, text: text.text, startMs: text.startMs, endMs: text.endMs, x: text.x, y: text.y, style: text.style, size: text.size, font: text.font ?? null, brandStyle: text.brand?.style ?? null })),
    music: timeline.music ? { assetId: timeline.music.assetId, fileName: library[timeline.music.assetId]?.fileName ?? null, volume: timeline.music.volume, bpm: timeline.music.bpm ?? null, onBeat: timeline.music.onBeat ?? false } : null,
    sfxCount: timeline.sfx?.length ?? 0,
    voiceover: timeline.voiceover ? { script: timeline.voiceover.script, voice: timeline.voiceover.voice, atMs: timeline.voiceover.atMs } : null,
    hook: timeline.hook ? timeline.hook.kind : null,
    opening: timeline.opening ?? null,
  };
}

const getReel: ToolSpec = {
  name: "get_reel",
  title: "Read a reel",
  description:
    "Read one reel: a summary of its cut (clips in order with ids, start and length in ms, titles, music), its revision (pass it to apply_commands), the media it uses, the last export, and `issues` that would block an export. `full: true` adds the complete timeline JSON, which is large; ask for it only when the summary lacks a field.",
  scopes: ["reels:read"],
  readOnly: true,
  input: {
    reelId: z.string().min(1).describe("Reel id from list_reels or create_reel."),
    full: z.boolean().default(false).describe("Also return the whole timeline document."),
  },
  async run(ctx, args) {
    const { reelId, full } = args as { reelId: string; full: boolean };
    const loaded = await loadReel(ctx.user, reelId);
    if (!loaded) return failure(NO_REEL);
    const [reel, lastExport] = await Promise.all([
      prisma.reel.findFirst({ where: { id: reelId, workspaceId: ctx.user.workspaceId }, select: { caption: true } }),
      prisma.renderJob.findFirst({ where: { reelId, workspaceId: ctx.user.workspaceId, kind: "REEL" }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, progress: true, createdAt: true } }),
    ]);
    const issues = instagramIssues(loaded.timeline, reel?.caption ?? "");
    return ok({
      reelId: loaded.id,
      title: loaded.title,
      revision: loaded.revision,
      caption: reel?.caption ?? "",
      url: reelUrl(ctx, loaded.id),
      ...summarise(loaded.timeline, loaded.library),
      media: Object.values(loaded.library).map((asset) => ({ id: asset.id, kind: asset.kind, fileName: asset.fileName, durationMs: asset.durationMs, width: asset.width, height: asset.height, hasSpeech: asset.kind === "VIDEO" && hasSpeech(asset.transcript), credit: asset.credit })),
      canExport: canExport(issues),
      issues,
      brandKit: loaded.brandKit ? { id: loaded.brandKit.id, name: loaded.brandKit.name, styles: loaded.brandKit.styles.map((style) => style.name), hint: "get_brand_kit has the palette and what each style looks like; apply one with applyTextStyle." } : null,
      lastExport: lastExport ? { exportId: lastExport.id, status: lastExport.status, progress: lastExport.progress, createdAt: lastExport.createdAt.toISOString() } : null,
      ...(full ? { timeline: loaded.timeline } : {}),
    });
  },
};

const getBrandKit: ToolSpec = {
  name: "get_brand_kit",
  title: "Read the workspace's brand kit",
  description:
    "Read this workspace's brand kit: its named text styles (what each is for and exactly how it looks: font, weight, slant, hard shadow, plate), its fonts and its palette. Apply a style to a title with the apply_commands command applyTextStyle { textId, style: '<name>' } (style null takes it off). Answers { brandKit: null } when the workspace has no kit; then use the house style instead.",
  scopes: ["reels:read"],
  readOnly: true,
  input: {
    style: z.string().trim().max(40).optional().describe("Only this style (its name), to check one look without the whole kit."),
  },
  async run(ctx, args) {
    const { style } = args as { style?: string };
    const kit = await workspaceBrandKit(ctx.user.workspaceId);
    if (!kit) return ok({ brandKit: null, message: "This workspace has no brand kit. Use the house style." });
    const described = describeBrandKit(kit);
    if (!style) return ok({ brandKit: described });
    const found = described.styles.filter((entry) => entry.name === style);
    if (found.length === 0) return failure(`The ${kit.name} kit has no style called ${style}. Its styles are: ${kit.styles.map((entry) => entry.name).join(", ")}.`);
    return ok({ brandKit: { ...described, styles: found } });
  },
};

const listMedia: ToolSpec = {
  name: "list_media",
  title: "List library media",
  description:
    "List media in the person's library (their uploads, imported stock and AI shots; `includeStarter: true` adds the shared starter library): id, kind, file name, duration, size, room label and licence credit. Use the ids with create_reel, add_media (mode library) or setMusic.",
  scopes: ["reels:read"],
  readOnly: true,
  input: {
    kind: z.enum(["VIDEO", "IMAGE", "AUDIO"]).optional().describe("Only this kind."),
    query: z.string().trim().max(80).optional().describe("Only file names containing this text."),
    includeStarter: z.boolean().default(false).describe("Also list the shared starter library."),
    limit: z.number().int().min(1).max(100).default(40),
    offset: z.number().int().min(0).max(5000).default(0),
  },
  async run(ctx, args) {
    const { kind, query, includeStarter, limit, offset } = args as { kind?: "VIDEO" | "IMAGE" | "AUDIO"; query?: string; includeStarter: boolean; limit: number; offset: number };
    const where = {
      ...(includeStarter ? mediaScope(ctx.user.workspaceId) : { workspaceId: ctx.user.workspaceId }),
      ...(kind ? { kind } : {}),
      ...(query ? { fileName: { contains: query, mode: "insensitive" as const } } : {}),
      instagramAudioId: null,
    };
    const rows = await prisma.mediaAsset.findMany({ where, orderBy: { createdAt: "desc" }, skip: offset, take: limit });
    const assets = await toLibraryAssets(rows);
    return ok({
      media: assets.map((asset, index) => ({
        id: asset.id,
        kind: asset.kind,
        fileName: asset.fileName,
        durationMs: asset.durationMs,
        width: asset.width,
        height: asset.height,
        isPano: asset.isPano,
        room: asset.room,
        bpm: asset.bpm,
        hasSpeech: asset.kind === "VIDEO" && hasSpeech(asset.transcript),
        credit: asset.credit,
        shared: rows[index].shared,
        aiGenerated: asset.isAiGenerated ?? false,
      })),
    });
  },
};

const STOCK_CHECK_LIMIT = 24;

const searchStock: ToolSpec = {
  name: "search_stock",
  title: "Search stock footage",
  description:
    "Search free stock video (Pixabay licence) and get sets of clips from one creator and one shoot, so they cut together. Defaults are portrait only, no people, no burnt-in text. Each clip's `id` goes to add_media (mode stock). Searching runs image checks, so it is rate limited; make the query specific (e.g. 'infinity pool dusk villa').",
  scopes: ["reels:read"],
  readOnly: true,
  limits: (userId) => [{ key: `mcp:stock:${userId}`, max: 30, windowMs: HOUR }],
  input: {
    query: z.string().trim().min(1).max(100).describe("What to look for."),
    minSeconds: z.number().min(0).max(120).optional(),
    maxSeconds: z.number().min(1).max(120).optional(),
    portrait: z.boolean().default(true).describe("Only vertical clips."),
    allowPeople: z.boolean().default(false),
    allowText: z.boolean().default(false),
    perPage: z.number().int().min(10).max(100).default(40),
  },
  async run(ctx, args) {
    const { query, minSeconds, maxSeconds, portrait, allowPeople, allowText, perPage } = args as { query: string; minSeconds?: number; maxSeconds?: number; portrait: boolean; allowPeople: boolean; allowText: boolean; perPage: number };
    const { isStockConfigured, searchStockClips } = await import("../stock");
    if (!isStockConfigured()) return failure("Stock search is not set up on this server.");
    const { checkStockClips } = await import("../stock-check");
    const filters: StockFilters = { portrait, noPeople: !allowPeople, noText: !allowText, minMs: minSeconds ? Math.round(minSeconds * 1000) : undefined, maxMs: maxSeconds ? Math.round(maxSeconds * 1000) : undefined };
    try {
      const hits = await searchStockClips(query, perPage);
      const shaped = hits.filter((clip) => passesStockFilters(clip, { portrait: filters.portrait, minMs: filters.minMs, maxMs: filters.maxMs }));
      const byTags = shaped.filter((clip) => passesStockFilters(clip, { noPeople: filters.noPeople, noText: filters.noText }));
      const checked = await checkStockClips(ctx.user.workspaceId, byTags, STOCK_CHECK_LIMIT);
      const kept = checked.filter((clip) => passesStockFilters(clip, filters)).map(({ sample: _sample, ...clip }) => (void _sample, clip));
      const groups = groupStock(kept);
      return ok({
        query,
        total: hits.length,
        groups: groups.map((group) => ({
          label: group.label,
          creator: group.creator,
          clips: group.clips.map((clip) => ({ id: clip.id, durationMs: clip.durationMs, width: clip.width, height: clip.height, tags: clip.tags.slice(0, 8), poster: clip.poster, page: clip.url })),
        })),
      });
    } catch (error) {
      return failure(error instanceof Error ? error.message : "Stock search failed.");
    }
  },
};

// ── Creating and filling reels ───────────────────────────────────

const createReel: ToolSpec = {
  name: "create_reel",
  title: "Create a reel",
  description: "Create a new reel in the person's account, optionally with library photos and videos already on its timeline in the order given (photos get 3 s with a slow push-in, videos play whole). Music is not accepted here; set it with apply_commands setMusic. Returns the reel id and revision 0.",
  scopes: ["reels:write"],
  readOnly: false,
  write: true,
  input: {
    title: z.string().trim().min(1).max(80).optional().describe("Defaults to 'Reel N'."),
    mediaIds: z.array(z.string().min(1)).max(30).optional().describe("Library media ids (photos and videos) in cut order. See list_media, add_media."),
    caption: z.string().max(2200).optional().describe("Instagram caption text kept with the reel. Plain, no emoji bait."),
  },
  async run(ctx, args) {
    const { title, mediaIds, caption } = args as { title?: string; mediaIds?: string[]; caption?: string };
    let timeline: Timeline = emptyTimeline();
    if (mediaIds?.length) {
      const rows = await prisma.mediaAsset.findMany({ where: { id: { in: mediaIds }, ...mediaScope(ctx.user.workspaceId) } });
      const assets = new Map((await toLibraryAssets(rows)).map((asset) => [asset.id, asset]));
      const missing = mediaIds.filter((id) => !assets.has(id));
      if (missing.length) return failure(`Not in this account's library: ${missing.join(", ")}. See list_media.`);
      const audio = mediaIds.filter((id) => assets.get(id)?.kind === "AUDIO");
      if (audio.length) return failure(`${audio.join(", ")} is music; leave it out here and use apply_commands setMusic.`);
      timeline = addClips(timeline, mediaIds.map((id) => clipForAsset(assets.get(id)!)));
    }
    const count = await prisma.reel.count({ where: { workspaceId: ctx.user.workspaceId } });
    const reel = await prisma.reel.create({
      data: { workspaceId: ctx.user.workspaceId, title: title ?? `Reel ${count + 1}`, timeline: parseTimeline(timeline), ...(caption ? { caption } : {}) },
      select: { id: true, title: true, revision: true },
    });
    return ok({ reelId: reel.id, title: reel.title, revision: reel.revision, clipCount: timeline.clips.length, url: reelUrl(ctx, reel.id) });
  },
};

/** Largest file `add_media` hands a one-shot upload URL for; bigger files go through the app's uploader (parts). */
const MAX_CONNECTOR_UPLOAD_BYTES = 32 * 1024 * 1024;

const addMedia: ToolSpec = {
  name: "add_media",
  title: "Add media to the library or a reel",
  description:
    "Get footage into the account. `mode` is one of: " +
    "'stock' - import stock clips by `stockIds` (the `id` values from search_stock; up to 12; licence and credit are recorded). " +
    "'library' - nothing to import, just place existing library media (`mediaIds`) on a reel. " +
    "'prepare_upload' - for agents that can send HTTP requests: give `fileName`, `contentType`, `sizeBytes` (max 32 MB) and get back a one-time `uploadUrl`; PUT the file bytes to it with that exact Content-Type, then call 'finish_upload'. " +
    "'finish_upload' - give the `objectKey` from prepare_upload plus `fileName`, `durationMs` (video), `width`, `height` to record the asset. " +
    "With `reelId`, the new or named clips are appended to the end of that reel (or at `atIndex`) as a new revision; without it they only go into the library. Never add people's faces or other people's footage without the person's say-so.",
  scopes: ["reels:write"],
  readOnly: false,
  write: true,
  limits: (userId, args) => (args.mode === "stock" || args.mode === "prepare_upload" ? [{ key: `mcp:import:${userId}`, max: 12, windowMs: HOUR }] : []),
  input: {
    mode: z.enum(["stock", "library", "prepare_upload", "finish_upload"]),
    reelId: z.string().min(1).optional().describe("Append the clips to this reel."),
    atIndex: z.number().int().min(0).max(100).optional().describe("Position among the reel's clips; default the end."),
    stockIds: z.array(z.number().int().positive()).min(1).max(12).optional().describe("mode stock: ids from search_stock."),
    mediaIds: z.array(z.string().min(1)).min(1).max(30).optional().describe("mode library: existing library media ids."),
    fileName: z.string().min(1).max(200).optional(),
    contentType: z.string().max(100).optional().describe("mode prepare_upload, e.g. video/mp4, image/jpeg, audio/mpeg."),
    sizeBytes: z.number().int().positive().max(MAX_CONNECTOR_UPLOAD_BYTES).optional(),
    objectKey: z.string().min(1).max(300).optional().describe("mode finish_upload: from prepare_upload."),
    durationMs: z.number().int().positive().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  },
  async run(ctx, args) {
    const input = args as { mode: "stock" | "library" | "prepare_upload" | "finish_upload"; reelId?: string; atIndex?: number; stockIds?: number[]; mediaIds?: string[]; fileName?: string; contentType?: string; sizeBytes?: number; objectKey?: string; durationMs?: number; width?: number; height?: number };
    const { workspaceId } = ctx.user;
    if (input.mode === "prepare_upload") {
      if (!input.fileName || !input.contentType || !input.sizeBytes) return failure("prepare_upload needs fileName, contentType and sizeBytes.");
      const { createUpload } = await import("@/app/actions");
      const ticket = await createUpload({ fileName: input.fileName, contentType: input.contentType, sizeBytes: input.sizeBytes, withThumbnail: false });
      if (!ticket.ok) return failure(ticket.error);
      if (!ticket.uploadUrl) return failure("That file is too big for a one-shot upload here. Upload it in the app instead.");
      return ok({ objectKey: ticket.objectKey, uploadUrl: ticket.uploadUrl, method: "PUT", headers: { "Content-Type": ticket.contentType }, next: "PUT the bytes to uploadUrl, then call add_media with mode finish_upload." });
    }

    let assets: { id: string; kind: "VIDEO" | "IMAGE" | "AUDIO"; durationMs: number | null; isPano: boolean; spot: Spot | null; room: string | null; fileName: string }[] = [];
    let failed: { id: number; error: string }[] = [];
    if (input.mode === "stock") {
      if (!input.stockIds) return failure("mode stock needs stockIds.");
      const { importStockClips } = await import("../stock-import");
      const imported = await importStockClips(workspaceId, input.stockIds);
      assets = imported.assets;
      failed = imported.failed;
      if (assets.length === 0) return failure("None of those clips could be imported.", { failed });
    } else if (input.mode === "library") {
      if (!input.mediaIds) return failure("mode library needs mediaIds.");
      const rows = await prisma.mediaAsset.findMany({ where: { id: { in: input.mediaIds }, ...mediaScope(workspaceId) } });
      const found = new Map((await toLibraryAssets(rows)).map((asset) => [asset.id, asset]));
      const missing = input.mediaIds.filter((id) => !found.has(id));
      if (missing.length) return failure(`Not in this account's library: ${missing.join(", ")}.`);
      assets = input.mediaIds.map((id) => found.get(id)!);
    } else {
      if (!input.objectKey || !input.fileName) return failure("finish_upload needs objectKey and fileName.");
      const { confirmUpload } = await import("@/app/actions");
      const confirmed = await confirmUpload({ objectKey: input.objectKey, thumbKey: null, fileName: input.fileName, durationMs: input.durationMs ?? null, width: input.width ?? null, height: input.height ?? null });
      if (!confirmed.ok) return failure(confirmed.error);
      assets = [confirmed.asset];
    }

    const base = { assets: assets.map((asset) => ({ id: asset.id, kind: asset.kind, fileName: asset.fileName, durationMs: asset.durationMs })), failed };
    if (!input.reelId) return ok({ ...base, addedToReel: null });
    const placeable = assets.filter((asset) => asset.kind !== "AUDIO");
    if (placeable.length === 0) return ok({ ...base, addedToReel: null, note: "Music cannot be placed as a clip; use apply_commands setMusic with the asset id." });
    const loaded = await loadReel(ctx.user, input.reelId);
    if (!loaded) return failure(NO_REEL, base);
    const next = addClips(loaded.timeline, placeable.map((asset) => clipForAsset(asset)), input.atIndex);
    const saved = await saveReelFor(ctx.user, { id: loaded.id, revision: loaded.revision, timeline: next });
    if (!saved.ok) return failure(saved.message, base);
    return ok({ ...base, addedToReel: { reelId: loaded.id, revision: saved.revision, clipIds: next.clips.filter((clip) => placeable.some((asset) => asset.id === clip.assetId)).map((clip) => clip.id), clipCount: next.clips.length } });
  },
};

// ── Editing ──────────────────────────────────────────────────────

const COMMAND_SHEET = [
  "trimClip{clipId,window:{sourceStartMs,sourceEndMs}}",
  "moveClip{clipId,toIndex}",
  "splitClip{atMs,newId}",
  "deleteClip{clipId}",
  "duplicateClip{clipId,newId}",
  "setSpeed{clipId,speed 0.25-4}",
  "setTransition{clipId,transition:cut|fade|softDissolve|focusPull|lightLeak|walk} (cut is the default, whip and speedRamp are retired)",
  "updateClip{clipId,patch:{filter,motion,zoom 1-2,fit,volume,...}}",
  "setMusic{music:{assetId,sourceStartMs,volume 0-1}|null,snap?}",
  "snapToBeat{}",
  "pace{energy 0-1}",
  "setOnBeat{on}",
  "retime{shotMs}",
  "retimeToLength{totalMs}",
  "hook{pattern:voice-in|motion-in|text-punch|pattern-interrupt|question|null}",
  "addText{text:{id,text,startMs,endMs?,x,y,style,size,font,shadow,color}}",
  "updateText{textId,patch} (patch.animation auto|fadeQuick|maskUp|trackIn|blurIn, auto on style elegant tracks in, style location is a location lower third, patch.kinetic {preset:\"focus\"} brings each word into focus out of a blur (ADR 0092) and syncTextToSpeech then lands each on its spoken word, patch.font tight is Inter Tight, the heavy tight grotesk, and patch.blend invert works with both)",
  "setEndCard{endCard:{text,durationMs 1000-5000,reveal:cut|leak}|null}",
  "setVoiceover{voiceover:null} (takes the spoken voiceover and its vo- captions off, the add_voiceover tool adds one)",
  "applyTextStyle{textId,style:<kit style name>|null}",
  "syncTextToSpeech{textId,clipId?,holdMs?} (the title appears with the first word it repeats from the clip's speech, each word as it is said, and fades after the last, and a title with kinetic focus keeps it)",
  "composeKeywordLockup{clipIds?,keywords?:[word],keywordsOnly?,capHeight? 0.05-0.14,fill?:{kind:gradient,colors:[#hex x2-4],angle?}|{kind:image,assetId},cta?:{keyword,caption?},interlock? (default true),follow? (default true),brandStyle?,remove?} (talking-head type from the clips' speech, ADR 0089: per phrase one huge white serif keyword behind the presenter's head, the other words a one-word-at-a-time caption under her chin, each on its spoken onset, while a phrase of 4 words or fewer instead tucks its other words into the keyword as small italic companions (interlock), every lockup following her head through the phrase (follow), and a dryRun answers `lockups` with the picks, places and layout)",
  "setRamp{clipId,ramp}",
  "setCamera{clipId,camera}",
  "cutaways{everyMs|null}",
  "matchCuts{motion}",
  "matchLook{referenceClipId?,strength?}",
  "autoSfx{}",
  "setSfx{sfx}",
  "applyFinish{finish}",
].join("; ");

/** Every command type but the two a batch cannot hold (a batch inside a batch, a proposal that carries its own generation check). */
const BATCHABLE_TYPES = COMMAND_TYPES.filter((type) => type !== "batch" && type !== "applyProposal") as [Command["type"], ...Command["type"][]];
const commandSchema = z.object({ type: z.enum(BATCHABLE_TYPES) }).passthrough();

const applyCommands: ToolSpec = {
  name: "apply_commands",
  title: "Change a reel with commands",
  description:
    `Change a reel's cut with document commands, run in order as one atomic batch (all land or none; at most ${MAX_COMMANDS}; no nested batch). Each is { type, ...fields }. Common ones: ${COMMAND_SHEET}. The rest of the accepted types are listed in the schema. ` +
    "Read the reel first (get_reel) and pass its `revision`; a 409 means the person edited it meanwhile. `dryRun: true` returns what would change and saves nothing - use it before big moves. A refused command answers with the reason and saves nothing. Each saved batch is one new revision, shown in the editor like any save. Ids you create (newId, text id) must be unique strings. " +
    STYLE_HINTS,
  scopes: ["reels:read"],
  readOnly: false,
  write: true,
  input: {
    reelId: z.string().min(1),
    commands: z.array(commandSchema).min(1).max(MAX_COMMANDS),
    revision: z.number().int().min(0).optional().describe("The revision you read; defaults to the current one."),
    dryRun: z.boolean().default(false),
    returnTimeline: z.boolean().default(false).describe("Include the whole resulting timeline (large)."),
  },
  async run(ctx, args) {
    const { reelId, commands, revision, dryRun, returnTimeline } = args as { reelId: string; commands: unknown[]; revision?: number; dryRun: boolean; returnTimeline: boolean };
    if (!dryRun && !ctx.scopes.includes("reels:write")) return failure("Changing a reel needs the reels:write permission. Reconnect and allow it, or use dryRun.");
    const accepted = commands.filter(isCommand).filter(inBatch);
    if (accepted.length !== commands.length) return failure("Some commands are not accepted (unknown type, or a nested batch / applyProposal). See the schema for the type list.");
    const command: Command = accepted.length === 1 ? accepted[0] : { type: "batch", commands: accepted as never };
    const loaded = await loadReel(ctx.user, reelId);
    if (!loaded) return failure(NO_REEL);
    const outcome = await applyReelCommand(ctx.user, loaded, command, revision ?? loaded.revision, { dryRun });
    if (!outcome.ok) return failure(outcome.message, { status: outcome.status, changes: outcome.result?.changes ?? [], currentRevision: outcome.status === 409 ? loaded.revision : undefined });
    const { timeline, changes, warning } = outcome.result;
    return ok({
      dryRun,
      revision: outcome.revision,
      changes,
      warning: warning ?? null,
      durationMs: timelineDurationMs(timeline),
      clipCount: timeline.clips.length,
      opening: timeline.opening ?? null,
      // A keyword lockup (ADR 0089) answers with its picks and places, so a dry run shows them without the whole timeline.
      ...(accepted.some((item) => (item as Command).type === "composeKeywordLockup") ? { lockups: describeLockups(timeline) } : {}),
      ...(returnTimeline ? { timeline } : {}),
    });
  },
};

// ── Voiceover (ADR 0099) ─────────────────────────────────────────

const addVoiceoverTool: ToolSpec = {
  name: "add_voiceover",
  title: "Add a spoken voiceover",
  description:
    `Speak a short script over the reel in one of the offered voices, with captions on its words (each word coming into focus as it is said) and the music dipping under it. Voices: ${VOICES.map((voice) => `${voice.id} (${voice.description})`).join("; ")}. ` +
    `The script is 2 to 4 short sentences, under ${VOICEOVER_MAX_CHARS} characters, plain spoken English with no hashtags or emoji; it should carry the message and never invent facts. The reel is lengthened when the voiceover would run past its end. ` +
    "It takes up to a few minutes (the worker speaks and transcribes it) and saves one new revision; read the reel again afterwards. Adding another replaces the voiceover and its captions; apply_commands setVoiceover{voiceover:null} takes it off. With a voiceover, keep other titles few: its captions carry the words.",
  scopes: ["reels:write"],
  readOnly: false,
  write: true,
  limits: (userId) => [{ key: `mcp:voice:${userId}`, max: 20, windowMs: HOUR }],
  input: {
    reelId: z.string().min(1),
    script: z.string().trim().min(2).max(VOICEOVER_MAX_CHARS).describe("What is said."),
    voice: z.enum(VOICES.map((voice) => voice.id) as [VoiceId, ...VoiceId[]]).default(DEFAULT_VOICE),
    captions: z.boolean().default(true).describe("Captions on the spoken words."),
    atMs: z.number().int().min(0).max(60_000).default(0).describe("Where in the reel it starts."),
  },
  async run(ctx, args) {
    const { reelId, script, voice, captions, atMs } = args as { reelId: string; script: string; voice: VoiceId; captions: boolean; atMs: number };
    const { addVoiceover } = await import("../voiceover");
    const added = await addVoiceover(ctx.user, { reelId, script, voice, captions, atMs });
    if (!added.ok) return failure(added.message, { status: added.status });
    const short = added.shortByMs > 0 ? ` The reel still ends ${(added.shortByMs / 1000).toFixed(1)} s before the voiceover does: add footage (or shorten the script and add it again).` : "";
    return ok({ ...added, voice: voiceName(voice), next: `Read the reel again (get_reel) before further changes.${short}` });
  },
};

// ── Verifying an export ──────────────────────────────────────────

const exportJob = (ctx: ToolContext, id: string) => prisma.renderJob.findFirst({ where: { id, workspaceId: ctx.user.workspaceId, kind: { not: "PREVIEW" } }, include: { output: true } });
const NO_EXPORT = "No finished export with that id. Start one with export_reel and wait for get_export to say SUCCEEDED.";

const getFrames: ToolSpec = {
  name: "get_frames",
  title: "Look at frames of an export",
  description:
    "Look at a finished export as images. Give `times` in seconds from the start (a negative number counts back from the end; up to 12). By default you get ONE contact sheet with the frames side by side in the order asked, which is cheapest to read; set sheet false for separate images. Check frame 0 (is something already on screen?), the titles' readability, cuts, and the last frame. Takes a few seconds the first time per export.",
  scopes: ["reels:read"],
  readOnly: true,
  limits: (userId) => [{ key: `mcp:verify:${userId}`, max: 60, windowMs: HOUR }],
  input: {
    exportId: z.string().min(1).describe("From export_reel / get_export."),
    times: z.array(z.number().min(-600).max(600)).min(1).max(12),
    width: z.number().int().min(120).max(540).default(270).describe("Width of each frame in px."),
    sheet: z.boolean().default(true),
  },
  async run(ctx, args) {
    const { exportId, times, width, sheet } = args as { exportId: string; times: number[]; width: number; sheet: boolean };
    const verify = await import("../render-verify");
    const job = await exportJob(ctx, exportId);
    if (!job?.output) return failure(NO_EXPORT);
    if (!verify.ffmpegAvailable()) return failure("Frames need ffmpeg on this server, which is not available right now.");
    const timeline = verify.exportTimeline(job.payload);
    const durationMs = timeline ? timelineDurationMs(timeline) : 10 * MINUTE;
    const asked = verify.parseTimes(times.join(","), durationMs);
    if (asked.length === 0) return failure(`Give reel times in seconds (up to ${verify.VERIFY.maxTimes}).`);
    const px = verify.parseWidth(String(width));
    let frames: Buffer[];
    try {
      frames = await verify.framesAt(job.output.objectKey, asked, px);
    } catch (error) {
      return failure(`Could not read the frames: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    const pictures = sheet && frames.length > 1 ? [await verify.contactSheet(frames, px)] : frames;
    return {
      content: [
        { type: "text", text: JSON.stringify({ ok: true, exportId: job.id, timesMs: asked, layout: sheet && frames.length > 1 ? "contact sheet, left to right in the order of timesMs" : "one image per time, in order" }) },
        ...pictures.map((picture) => ({ type: "image" as const, data: picture.toString("base64"), mimeType: "image/jpeg" })),
      ],
    };
  },
};

const getChecks: ToolSpec = {
  name: "get_checks",
  title: "Check an export",
  description:
    "The retention checks of a finished export: near-black or flash frames, an empty frame 0, frozen pictures, the loop seam, motion per second, titles reaching into Instagram's UI zones, the opening title's legibility time, the end against the song's bars, and the sound's problems (off-beat cuts, speech under the music, the drop mid-shot, holes). `gate.blocked` is what Post and Schedule in the app would refuse on. Fix what it names with apply_commands, re-export, and check again.",
  scopes: ["reels:read"],
  readOnly: true,
  limits: (userId) => [{ key: `mcp:verify:${userId}`, max: 60, windowMs: HOUR }],
  input: { exportId: z.string().min(1), fresh: z.boolean().default(false).describe("Recompute instead of using the stored result.") },
  async run(ctx, args) {
    const { exportId, fresh } = args as { exportId: string; fresh: boolean };
    const verify = await import("../render-verify");
    const { reelAudioTrace } = await import("../sound");
    const job = await exportJob(ctx, exportId);
    if (!job?.output) return failure(NO_EXPORT);
    let result;
    try {
      result = await verify.ensureChecks(job, { fresh });
    } catch (error) {
      return failure(`The checks failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    if (!result.checks) return failure(result.reason ?? "The checks are not available for this export.", { source: result.source });
    const trace = job.reelId ? await reelAudioTrace(ctx.user.workspaceId, job.reelId).catch(() => null) : null;
    const checks = verify.withAudio(result.checks, verify.audioProblemsFrom(trace));
    return ok({ exportId: job.id, reelId: job.reelId, source: result.source, gate: verify.gateFor(checks), checks });
  },
};

const getAudioTrace: ToolSpec = {
  name: "get_audio_trace",
  title: "Read a reel's sound",
  description:
    "What a sound editor would hear, as data, so you do not need to listen: the reel's beats, cuts, speech and placed sounds in reel time, the last export's loudness every 250 ms (when one has been rendered), the recommended post sound volume, and the problems found (off-beat cuts, speech under music, the drop mid-shot).",
  scopes: ["reels:read"],
  readOnly: true,
  input: { reelId: z.string().min(1) },
  async run(ctx, args) {
    const { reelId } = args as { reelId: string };
    const { reelAudioTrace } = await import("../sound");
    const trace = await reelAudioTrace(ctx.user.workspaceId, reelId);
    if (!trace) return failure(NO_REEL);
    return ok({ ...trace });
  },
};

// ── Exporting ────────────────────────────────────────────────────

const exportReel: ToolSpec = {
  name: "export_reel",
  title: "Export a reel",
  description:
    "Freeze the reel's current cut and queue a render (an MP4, 1080x1920 on paid plans). The same checks and plan limits as the Export button run first; if they stop it you get the reasons. Returns an `exportId`; poll get_export about every 10 s until status is SUCCEEDED (a reel usually takes one to three minutes). This does NOT post or schedule anything.",
  scopes: ["exports"],
  readOnly: false,
  write: true,
  limits: (userId) => [{ key: `mcp:export:${userId}`, max: 10, windowMs: HOUR }],
  input: { reelId: z.string().min(1) },
  async run(ctx, args) {
    const { reelId } = args as { reelId: string };
    const { queueReelExport } = await import("../export-reel");
    const startedAt = new Date(Date.now() - 1000);
    const queued = await queueReelExport(ctx.user, reelId);
    if (!queued.ok) {
      const blocking = queued.issues.filter((issue) => issue.level === "error");
      return failure(queued.message ?? (blocking[0]?.message ?? "The reel has problems that block export."), { issues: queued.issues, upgrade: queued.upgrade ?? false });
    }
    const job = await prisma.renderJob.findFirst({ where: { reelId, workspaceId: ctx.user.workspaceId, kind: "REEL", createdAt: { gte: startedAt } }, orderBy: { createdAt: "desc" }, select: { id: true, status: true } });
    return ok({ exportId: job?.id ?? null, status: job?.status ?? "QUEUED", next: "Poll get_export until SUCCEEDED." });
  },
};

const getExport: ToolSpec = {
  name: "get_export",
  title: "Export status and download link",
  description: "Status of an export: QUEUED, RUNNING (with progress 0-100), SUCCEEDED or FAILED (with the error). When SUCCEEDED, `playUrl` and `downloadUrl` are short-lived links (about 15 minutes) to the MP4. Give `exportId`, or `reelId` for that reel's latest export.",
  scopes: ["exports"],
  readOnly: true,
  input: { exportId: z.string().min(1).optional(), reelId: z.string().min(1).optional() },
  async run(ctx, args) {
    const { exportId, reelId } = args as { exportId?: string; reelId?: string };
    if (!exportId && !reelId) return failure("Give exportId or reelId.");
    const job = await prisma.renderJob.findFirst({
      where: { workspaceId: ctx.user.workspaceId, kind: { not: "PREVIEW" }, ...(exportId ? { id: exportId } : { reelId }) },
      orderBy: { createdAt: "desc" },
      include: { output: true },
    });
    if (!job) return failure("No export found. Start one with export_reel.");
    const { outputUrls } = await import("../render-jobs");
    const urls = job.status === "SUCCEEDED" ? await outputUrls(job) : null;
    return ok({
      exportId: job.id,
      reelId: job.reelId,
      status: job.status,
      progress: job.progress,
      error: job.error,
      createdAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null,
      ...(urls ? { playUrl: urls.playUrl, downloadUrl: urls.downloadUrl } : {}),
    });
  },
};

// ── AI shots (the person's credits, the editor's gates) ──────────

/** What a shot asks for, priced as the editor prices it (ADR 0076, 0038): a draft, a voiced take, or a final from a draft. */
type AiShotPrice = { durationSeconds: 4 | 8; credits: number; costCents: number; voiced: boolean };
async function aiShotQuote(workspaceId: string, input: { durationSeconds: 4 | 8; shot?: AiShot; quality?: "draft" | "final"; finalOf?: string }): Promise<AiShotPrice | { error: string }> {
  if (input.finalOf) {
    const draft = await prisma.aiGeneration.findFirst({ where: { id: input.finalOf, workspaceId, status: "SUCCEEDED" }, select: { credits: true, durationSeconds: true, shot: true } });
    const stored = draft ? parseStoredAiShot(draft.shot) : null;
    if (!draft || !stored?.success || stored.data.tier !== "draft") return { error: "finalOf must name a finished draft (quality \"draft\") from this account." };
    const seconds = draft.durationSeconds as 4 | 8;
    const voiced = Boolean(stored.data.voice && stored.data.line);
    return { durationSeconds: seconds, credits: aiFinalCredits(seconds, voiced, draft.credits), costCents: aiClipCostCents(seconds, voiced), voiced };
  }
  if (input.quality === "draft") return { durationSeconds: input.durationSeconds, credits: AI_DRAFT_CREDITS, costCents: aiDraftCostCents(input.durationSeconds), voiced: false };
  const voiced = Boolean(input.shot?.voice && input.shot.line);
  return { durationSeconds: input.durationSeconds, credits: aiClipCredits(input.durationSeconds, voiced), costCents: aiClipCostCents(input.durationSeconds, voiced), voiced };
}

const generateAiShot: ToolSpec = {
  name: "generate_ai_shot",
  title: "Generate an AI video shot",
  description:
    "Start an AI video shot (4 or 8 s) from a prompt, optionally continuing from a library photo (`referenceAssetId`, JPEG/PNG). It costs the person's AI credits (4 s = 1 credit, 8 s = 2, a spoken line 1 more; a draft is 1) under the same limits as the editor. The first call only returns the quote and their balance and spends nothing; call again with `confirmCredits` equal to the quote to start it, and only after the person agreed to spend that. Poll get_ai_shot; when SUCCEEDED the clip is a library asset you can place with add_media (mode library).\n\n" +
    "Directed shots, the same fields as the editor's (POST /api/ai/generations): `shot` sets the mode, the starting and ending frames ({assetId, atMs}), the presenter composed into them (`compose`: `presenterId` or a `presenter` frame, with `allowGeneratedReference` for a generated one, `framing`, and what the composed `first`/`last` frame shows), a spoken `line` with `voice` (\"veo\" for Veo's own audio, \"lipsync\" with an optional `voiceId`), a camera `move`, and `direction`. `quality: \"draft\"` is the cheap silent 720p preview (no ending frame); `finalOf` makes a finished draft final with the same prompt, frames, seed and voice, its credit used toward the price (send any prompt; the draft's is used).",
  scopes: ["ai:generate"],
  readOnly: false,
  write: true,
  limits: (userId) => [{ key: `mcp:ai:${userId}`, max: 10, windowMs: HOUR }],
  input: {
    prompt: z.string().trim().min(10).max(2000).describe("What the camera sees and does. Describe real places and light; no text or logos in the picture."),
    referenceAssetId: z.string().min(1).max(64).optional(),
    durationSeconds: z.union([z.literal(4), z.literal(8)]).default(4),
    shot: z.record(z.string(), z.unknown()).optional().describe("A directed shot, as the editor sends it (see the description); checked against the editor's own rules."),
    quality: z.enum(["draft", "final"]).optional().describe("\"draft\": the cheap silent preview. Absent or \"final\": the full take."),
    finalOf: z.string().min(1).max(64).optional().describe("A finished draft's aiShotId, to make it final."),
    confirmCredits: z.number().int().min(0).optional().describe("Must equal the quoted credits to spend them."),
    requestId: z.string().uuid().optional().describe("Reuse the requestId from an earlier answer to retry without paying twice."),
  },
  async run(ctx, args) {
    const { prompt, referenceAssetId, durationSeconds, confirmCredits, requestId, quality, finalOf } = args as { prompt: string; referenceAssetId?: string; durationSeconds: 4 | 8; confirmCredits?: number; requestId?: string; quality?: "draft" | "final"; finalOf?: string };
    const { aiVideoConfigured, createAiGeneration, getAiBalance } = await import("../ai-video");
    if (!aiVideoConfigured()) return failure("AI video is not available on this server yet.");
    if (await aiIsOff(ctx.user.workspaceId)) return failure(AI_OFF_MESSAGE, { code: AI_OFF_CODE });
    let shot: AiShot | undefined;
    if (args.shot !== undefined && !finalOf) {
      const parsed = aiShotSchema.safeParse(quality === "draft" ? { ...(args.shot as object), tier: "draft" } : args.shot);
      if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "That shot is not valid.", { issues: parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
      shot = parsed.data;
    }
    const priced = await aiShotQuote(ctx.user.workspaceId, { durationSeconds, shot, quality, finalOf });
    if ("error" in priced) return failure(priced.error);
    const { credits } = priced;
    const balance = await getAiBalance(ctx.user.workspaceId);
    const quote = { credits, costCents: priced.costCents, remainingCredits: balance.remaining, durationSeconds: priced.durationSeconds, voiced: priced.voiced, ...(finalOf ? { finalOf } : quality === "draft" ? { tier: "draft" } : {}) };
    const id = requestId ?? randomUUID();
    if (confirmCredits === undefined) return ok({ started: false, quote, requestId: id, next: `Nothing was spent. To start it, call again with the same arguments, confirmCredits: ${credits} and requestId: "${id}".` });
    if (confirmCredits !== credits) return failure(`The quote for this ${priced.durationSeconds} s shot is ${credits} credit(s); confirmCredits must equal it.`, { quote });
    if (balance.remaining < credits) return failure(`Not enough AI credits: this needs ${credits} and the account has ${balance.remaining}. Credits are bought in the app.`, { quote });
    try {
      const { ensureWorkerRunning } = await import("../render-capacity");
      // The editor's own path: its checks on frames, presenter, voice, tier and finals, the reservation and the queue.
      const job = await createAiGeneration(ctx.user, {
        requestId: id, prompt, referenceAssetId, durationSeconds,
        ...(shot ? { shot } : {}), ...(quality ? { quality } : {}), ...(finalOf ? { finalOf } : {}),
      });
      await ensureWorkerRunning();
      return ok({ started: true, aiShotId: job.id, requestId: id, quote, next: "Poll get_ai_shot until SUCCEEDED." });
    } catch (error) {
      return failure(error instanceof Error ? error.message : "Could not start the generation.", { quote });
    }
  },
};

const getAiShot: ToolSpec = {
  name: "get_ai_shot",
  title: "AI shot status",
  description: "Status of an AI shot from generate_ai_shot: QUEUED, SUBMITTING, RUNNING, SUCCEEDED (with `assetId`, a library asset) or FAILED (with the reason; credits are returned when it fails).",
  scopes: ["reels:read"],
  readOnly: true,
  input: { aiShotId: z.string().min(1) },
  async run(ctx, args) {
    const { aiShotId } = args as { aiShotId: string };
    const row = await prisma.aiGeneration.findFirst({ where: { id: aiShotId, workspaceId: ctx.user.workspaceId }, select: { id: true, status: true, error: true, assetId: true, durationSeconds: true, credits: true, createdAt: true } });
    if (!row) return failure("No AI shot with that id in this account.");
    return ok({ aiShotId: row.id, status: row.status, error: row.error, assetId: row.assetId, durationSeconds: row.durationSeconds, credits: row.credits, createdAt: row.createdAt.toISOString() });
  },
};

// Style references (ADR 0102): reels the owner downloaded and shared, read into recipes to follow. Read-only here; a
// reference is added in the app (the owner uploads the video), never fetched from a link.
const listReferences: ToolSpec = {
  name: "list_references",
  title: "List style references",
  description:
    "The workspace's style references: reels the person downloaded (from Instagram or anywhere) and shared with ReelWalk so their reels can follow that style. Each has a status (measuring, reading, ready, failed) and, once ready, a short summary of how it is made. Read one in full with get_reference. References are added in the app at /references; their footage is never in the media library and must never be placed in a reel.",
  scopes: ["reels:read"],
  readOnly: true,
  input: { limit: z.number().int().min(1).max(50).default(20).describe("How many, newest first.") },
  async run(ctx, args) {
    const { limit } = args as { limit: number };
    const references = await listStyleReferences(ctx.user.workspaceId, limit);
    return ok({ references: references.map((r) => ({ id: r.id, title: r.title, status: r.status, sourceUrl: r.sourceUrl, durationMs: r.durationMs, summary: r.summary, error: r.error })) });
  },
};

const getReference: ToolSpec = {
  name: "get_reference",
  title: "Read a style reference's recipe",
  description:
    "Read one style reference's recipe: its shots (start, end, motion), pacing (shot count, median shot, cuts per second, first cut), speech (words per minute, when it starts, the transcript), beat (BPM and the share of cuts on a beat), and every title with when it shows, its box (fractions of the frame), its effect and its look. `gaps` lists title effects ReelWalk cannot draw yet: pick the nearest effect ReelWalk has (pop, rise, type, maskUp, trackIn, blurIn, fadeQuick, kinetic words) and say so. To follow it, match its pacing, title timing, placement and hook with the person's own footage and words; never copy its footage or its exact wording.",
  scopes: ["reels:read"],
  readOnly: true,
  input: { referenceId: z.string().min(1).max(64).describe("From list_references.") },
  async run(ctx, args) {
    const { referenceId } = args as { referenceId: string };
    const reference = await getStyleReference(ctx.user.workspaceId, referenceId);
    if (!reference) return failure("That reference is not in this workspace.");
    if (reference.status !== "ready") return ok({ id: reference.id, status: reference.status, error: reference.error, message: reference.status === "failed" ? "It could not be read; the person can add it again at /references." : "Still being read; try again in a minute." });
    return ok({ id: reference.id, title: reference.title, sourceUrl: reference.sourceUrl, summary: reference.summary, recipe: reference.recipe, gaps: reference.gaps });
  },
};

export const TOOLS: ToolSpec[] = [listWorkspacesTool, listReels, getReel, getBrandKit, listReferences, getReference, listMedia, searchStock, createReel, addMedia, applyCommands, addVoiceoverTool, getFrames, getChecks, getAudioTrace, exportReel, getExport, generateAiShot, getAiShot];

// ── Running one ──────────────────────────────────────────────────

export type Gate = (limits: Limit[]) => Promise<boolean>;

/** Checks scopes and limits, then runs the tool. A thrown error becomes a tool error with no internals in it. */
export async function runTool(spec: ToolSpec, ctx: ToolContext, args: Record<string, unknown>, allow: Gate): Promise<ToolResult> {
  const missing = spec.scopes.filter((scope) => !ctx.scopes.includes(scope));
  if (missing.length > 0) return failure(`${spec.name} needs the ${missing.join(", ")} permission, which this connection was not given. The person can reconnect and allow it.`, { missingScopes: missing });
  const userId = ctx.user.id;
  const limits: Limit[] = [{ key: `mcp:calls:${userId}`, max: 120, windowMs: MINUTE }];
  if (spec.write) limits.push({ key: `mcp:writes:${userId}`, max: 30, windowMs: MINUTE });
  limits.push(...(spec.limits?.(userId, args) ?? []));
  // The owner's non-expiring personal allowance also removes our connector's
  // artificial request caps. Membership, scopes and native generation/export
  // guards still run; neither a customer nor a client-supplied flag can opt in.
  const personalOwner = ctx.user.role === "OWNER" && ctx.user.homeWorkspaceId === ctx.user.workspaceId;
  const ownerGrant = personalOwner ? await prisma.aiCreditGrant.findUnique({
    where: { source: `owner-personal-lifetime:${ctx.user.workspaceId}` },
    select: { workspaceId: true, kind: true, expiresAt: true },
  }) : null;
  const unrestricted = ownerGrant?.workspaceId === ctx.user.workspaceId && ownerGrant.kind === "OWNER" && ownerGrant.expiresAt === null;
  if (!unrestricted && !(await allow(limits))) return failure("Rate limit reached for this connection. Wait a minute (or an hour for stock, AI and export calls) and try again.", { rateLimited: true });
  try {
    return await spec.run(ctx, args);
  } catch (error) {
    console.error(`mcp tool ${spec.name} failed`, error);
    return failure(`${spec.name} failed on the server. Try again; if it keeps failing, tell the person.`);
  }
}
