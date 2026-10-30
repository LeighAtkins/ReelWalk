import {
  AI_EDIT_PLAN_JSON_SCHEMA,
  AI_EDIT_SYSTEM_PROMPT,
  PLANS,
  aiEditPlanSchema,
  applyAiEditPlan,
  namesCuts,
  describeReel,
  fakeAiEditPlan,
  monthStart,
  nextPlan,
  referencedAssetIds,
  songMood,
  type AiAsset,
  type AiEditPlan,
  type AiSong,
  type InstagramAudioTrack,
  type Timeline,
  transcriptSchema,
} from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { AI_OFF_MESSAGE, aiIsOff } from "@/lib/ai-gate";
import { AiError, aiModel, isAiAvailable, isFakeAi, structuredAnswer, usageCostUsd } from "@/lib/openai";
import { workspacePlan } from "@/lib/plans";
import { isUnlimited } from "@/lib/quotas";
import { instagramSongs } from "@/lib/instagram-songs";
import { labelRooms } from "@/lib/room-labels";
import { aimPano } from "@/lib/pano-aim";
import { toLibraryAssets, type LibraryAsset } from "@/lib/library";
import { mediaScope } from "@/lib/media-scope";
import { insideProviderGate } from "@/lib/provider-gate";

/** Library entries for media a new timeline uses that the old one did not: a song the AI picked plays at once. */
export async function newAssets(workspaceId: string, before: Timeline, after: Timeline): Promise<LibraryAsset[]> {
  const had = new Set(referencedAssetIds(before));
  const ids = referencedAssetIds(after).filter((id) => !had.has(id));
  if (ids.length === 0) return [];
  const rows = await prisma.mediaAsset.findMany({ where: { id: { in: ids }, ...mediaScope(workspaceId) } });
  return toLibraryAssets(rows);
}

/**
 * Asking for a change in words (ADR 0020): describe the reel, ask the model
 * for a plan, apply it with the editor's own operations, keep the record.
 * The caller decides what to do with the new timeline: the editor applies it
 * as an undoable step, the export screen saves it and starts a render.
 */

export type AskResult =
  | { ok: true; timeline: Timeline; note: string; applied: string[]; skipped: string[]; questions: string[]; editId: string; assets?: LibraryAsset[]; instagramPick?: InstagramAudioTrack; caption?: string }
  | { ok: false; message: string; upgrade?: boolean };

/** The studio's answers to the model's questions, sent back with the same request. */
export type AskAnswer = { question: string; answer: string };

/** Requests made this calendar month (UTC), whatever came of them. */
export function aiEditsThisMonth(workspaceId: string, now: Date = new Date()): Promise<number> {
  return prisma.aiEdit.count({ where: { workspaceId, createdAt: { gte: monthStart(now) } } });
}

type Allowance = { allowed: number; unlimited: boolean; planId: keyof typeof PLANS; planName: string };

/** The month's allowance of AI requests (Ask, director, Plan my shoot, notes). */
export async function aiEditAllowance(workspaceId: string): Promise<Allowance> {
  const [{ plan, id }, unlimited] = await Promise.all([workspacePlan(workspaceId), isUnlimited(workspaceId)]);
  return { allowed: plan.aiEditsPerMonth, unlimited, planId: id, planName: plan.name };
}

/** What the studio is told when the month's requests are used up. */
function allowanceSpent(allowance: Allowance): { message: string; upgrade: boolean } {
  const next = nextPlan(allowance.planId);
  return allowance.planId === "FREE"
    ? { message: `That is all ${allowance.allowed} of this month's free requests. The ${PLANS.AGENT.name} plan has ${PLANS.AGENT.aiEditsPerMonth} a month.`, upgrade: true }
    : { message: `That makes ${allowance.allowed} requests this month, the ${allowance.planName} plan's allowance. It resets on the 1st${next ? `; ${next.name} has ${next.aiEditsPerMonth}` : ""}.`, upgrade: next !== null };
}

/** Why AI requests cannot be made here at all (not set up, or AI off for the workspace), or null. Says nothing of the allowance. */
export async function aiAvailabilityReason(workspaceId: string): Promise<{ message: string; upgrade: boolean } | null> {
  if (!isAiAvailable()) return { message: "Asking for changes is not set up on this deployment.", upgrade: false };
  if (await aiIsOff(workspaceId)) return { message: AI_OFF_MESSAGE, upgrade: false };
  return null;
}

/**
 * Why another request cannot be made now, or null if it can. A quick answer
 * for screens and early refusals only: it is not a reservation, and two
 * requests can both pass it. What spends a request goes through reserveAiEdit.
 */
export async function aiEditBlockedReason(workspaceId: string): Promise<{ message: string; upgrade: boolean } | null> {
  const unavailable = await aiAvailabilityReason(workspaceId);
  if (unavailable) return unavailable;
  const [allowance, used] = await Promise.all([aiEditAllowance(workspaceId), aiEditsThisMonth(workspaceId)]);
  return allowance.unlimited || used < allowance.allowed ? null : allowanceSpent(allowance);
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** What a reservation's `create` is given: the moment it is made (to stamp the row with) and its key, if any. */
export type ReservationStamp = { now: Date; key?: string };

/**
 * Takes one of the month's AI requests, atomically (ADR 0095). Every consumer
 * (Ask, the director, Plan my shoot, notes) creates its AiEdit row here, before
 * any model call: under a transaction-scoped advisory lock per workspace
 * (safe on the transaction pooler) the month is counted and the row created in
 * one transaction, so parallel requests of any kind can never pass the
 * allowance.
 *
 * - One timestamp, the database's (`now()` of this transaction), decides the
 *   month counted and stamps the row (`create` must use `stamp.now` for its
 *   `createdAt`), so a request made across midnight UTC counts in the month it
 *   is stamped in. `at` replaces it (tests).
 * - `key` is the request's own identity (a durable step and its generation, a
 *   job): a request that already reserved under it gets its row back
 *   (`reused`) and is not charged again, so a replayed step is charged once.
 *   `create` must store the key in the row's plan as `reservation`.
 * - `before` runs under the same lock (a note's retry and one-per-reel checks)
 *   and may answer instead, without spending anything.
 */
export async function reserveAiEdit<T extends { id: string }, E = never>(
  workspaceId: string,
  create: (tx: Tx, stamp: ReservationStamp) => Promise<T>,
  options: { before?: (tx: Tx) => Promise<E | null>; key?: string; at?: Date } = {},
): Promise<{ ok: true; value: T | { id: string }; reused: boolean; at: Date } | { ok: false; early: E } | { ok: false; blocked: { message: string; upgrade: boolean } }> {
  const allowance = await aiEditAllowance(workspaceId);
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`ai-allowance:${workspaceId}`}, 0))) AS lock`;
      const now = options.at ?? (await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`)[0].now;
      if (options.key) {
        const row = await tx.aiEdit.findFirst({ where: { workspaceId, plan: { path: ["reservation"], equals: options.key } }, select: { id: true } });
        if (row) return { ok: true as const, value: row, reused: true, at: now };
      }
      const early = options.before ? await options.before(tx) : null;
      if (early !== null) return { ok: false as const, early };
      if (!allowance.unlimited) {
        const used = await tx.aiEdit.count({ where: { workspaceId, createdAt: { gte: monthStart(now) } } });
        if (used >= allowance.allowed) return { ok: false as const, blocked: allowanceSpent(allowance) };
      }
      return { ok: true as const, value: await create(tx, { now, key: options.key }), reused: false, at: now };
    },
    { timeout: 15_000 },
  );
}

const title = (fileName: string) => fileName.replace(/\.[a-z0-9]{2,4}$/i, "");

/**
 * What the model may see: the reel's own sources, every song the studio could
 * switch to, and the studio's own recent photos and clips that the reel does
 * not use yet (its uploads, not the shared starter library, which would
 * swamp a listing with other people's rooms).
 */
export async function context(workspaceId: string, timeline: Timeline): Promise<{ assets: Record<string, AiAsset>; songs: AiSong[]; unused: AiAsset[] }> {
  const used = referencedAssetIds(timeline);
  const select = { id: true, kind: true, fileName: true, durationMs: true, width: true, height: true, bpm: true, beatOffsetMs: true, instagramAudioId: true, room: true, shared: true, transcript: true } as const;
  const [rows, own] = await Promise.all([
    prisma.mediaAsset.findMany({
      where: { ...mediaScope(workspaceId), OR: [{ id: { in: used } }, { kind: "AUDIO", instagramAudioId: null }] },
      select,
      orderBy: { createdAt: "desc" },
      take: 160,
    }),
    prisma.mediaAsset.findMany({
      where: { workspaceId, shared: false, kind: { not: "AUDIO" }, id: { notIn: used } },
      select,
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
  ]);
  const toAsset = (row: (typeof rows)[number]): AiAsset => ({
    id: row.id,
    kind: row.kind,
    title: title(row.fileName),
    durationMs: row.durationMs,
    isPano: row.kind === "IMAGE" && row.width !== null && row.height !== null && Math.abs(row.width / row.height - 2) < 0.05,
    bpm: row.bpm,
    beatOffsetMs: row.beatOffsetMs,
    room: row.room,
    transcript: row.transcript ? transcriptSchema.safeParse(row.transcript).data ?? null : null,
    // Generated assets carry an "ai-" id (app shots and registered avatar takes alike).
    aiGenerated: row.id.startsWith("ai-"),
  });
  const assets: Record<string, AiAsset> = {};
  const songs: AiSong[] = [];
  for (const row of rows) {
    const asset = toAsset(row);
    assets[row.id] = asset;
    if (row.kind === "AUDIO" && !row.instagramAudioId) {
      // A song uploaded twice is one song; the studio's own uploads come first.
      const title = asset.title.replace(/^\d+[_ -]*/, "").replace(/^Mixkit[_ -]*/i, "").replace(/_/g, " ");
      if (songs.some((song) => song.title.toLowerCase() === title.toLowerCase())) continue;
      const own = !("shared" in row) || !(row as { shared?: boolean }).shared;
      songs.push({ id: row.id, title, bpm: row.bpm, mood: songMood(title, row.bpm), own });
    }
  }
  songs.sort((a, b) => Number(b.own ?? false) - Number(a.own ?? false));
  songs.splice(30);
  // Instagram only, where the studio can use it: the model picks from Instagram's library.
  const fromInstagram = await instagramSongs(workspaceId);
  if (fromInstagram.length > 0) songs.splice(0, songs.length, ...fromInstagram);
  const unused = own.map(toAsset);
  for (const asset of unused) assets[asset.id] = asset;
  return { assets, songs, unused };
}

export async function askForChange(input: {
  user: { id: string; workspaceId: string };
  reel: { id: string; title: string };
  timeline: Timeline;
  request: string;
  answers?: AskAnswer[];
  /** Longest request accepted: 600 characters typed by a person, more when the app writes it ("Make it for me"). */
  maxLength?: number;
  /** The request's own identity (a durable step and generation, a job): a replay of it is charged once (reserveAiEdit). */
  reservationKey?: string;
}): Promise<AskResult> {
  const request = input.request.trim();
  const maxLength = input.maxLength ?? 600;
  if (request.length < 3) return { ok: false, message: "Say what you would like changed." };
  if (request.length > maxLength) return { ok: false, message: `Keep the request under ${maxLength} characters.` };
  const unavailable = await aiAvailabilityReason(input.user.workspaceId);
  if (unavailable) return { ok: false, message: unavailable.message, upgrade: unavailable.upgrade };
  // The request is taken from the month's allowance before anything is asked of a model (reserveAiEdit).
  // A replayed durable step (ADR 0049) brings the same key and is charged once.
  const reserved = await reserveAiEdit(
    input.user.workspaceId,
    (tx, stamp) =>
      tx.aiEdit.create({ data: { workspaceId: input.user.workspaceId, userId: input.user.id, reelId: input.reel.id, request, note: "Working on it", plan: { kind: "ask-pending", ...(stamp.key ? { reservation: stamp.key } : {}) }, applied: [], skipped: [], model: "pending", createdAt: stamp.now }, select: { id: true } }),
    { key: input.reservationKey },
  );
  if (!reserved.ok) return "blocked" in reserved ? { ok: false, message: reserved.blocked.message, upgrade: reserved.blocked.upgrade } : { ok: false, message: "Try again." };
  const recordId = reserved.value.id;
  const fail = async (message: string): Promise<AskResult> => {
    await prisma.aiEdit.update({ where: { id: recordId }, data: { note: message } }).catch(() => undefined);
    return { ok: false, message };
  };

  // Shots that do not know their room are looked at once and named, so the
  // walk can be ordered and room labels shown; the names go on the clips too.
  const unnamed = [...new Set(input.timeline.clips.filter((clip) => !clip.room).map((clip) => clip.assetId))];
  const named = isFakeAi() ? {} : await labelRooms(input.user.workspaceId, unnamed);
  if (Object.keys(named).length > 0) {
    input = { ...input, timeline: { ...input.timeline, clips: input.timeline.clips.map((clip) => (clip.room || !named[clip.assetId] ? clip : { ...clip, room: named[clip.assetId] })) } };
  }

  const { assets, songs, unused } = await context(input.user.workspaceId, input.timeline);
  const description = describeReel({ title: input.reel.title, timeline: input.timeline, assets, songs, unused });
  const answers = (input.answers ?? []).filter((entry) => entry.question.trim() && entry.answer.trim()).slice(0, 3);
  const asked = answers.length ? `\n\nThe user answered your questions:\n${answers.map((entry) => `Q: ${entry.question.trim()}\nA: ${entry.answer.trim().slice(0, 200)}`).join("\n")}` : "";

  let plan: AiEditPlan;
  let model = "fake";
  let usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  if (isFakeAi()) {
    plan = fakeAiEditPlan(request, input.timeline, songs, unused);
  } else {
    const ask = () =>
      structuredAnswer({
        workspaceId: input.user.workspaceId,
        instructions: AI_EDIT_SYSTEM_PROMPT,
        input: `${description}\n\nThe user asks: ${request}${asked}`,
        schemaName: "reel_edit_plan",
        schema: AI_EDIT_PLAN_JSON_SCHEMA as unknown as Record<string, unknown>,
        // A whole-reel cut is a dozen or more operations at ~100 tokens each.
        maxOutputTokens: 8000,
      });
    let answer;
    try {
      // A dropped connection or a busy provider gets one more go before the user is told, except in the
      // durable worker: there an unanswered request is never sent again (ADR 0049); the step is unresolved.
      answer = await ask().catch((error) => (error instanceof AiError && error.transient && !insideProviderGate() ? ask() : Promise.reject(error)));
    } catch (error) {
      if (error instanceof AiError) {
        console.error("ai edit:", error.message);
        return fail(error.transient ? "The model did not answer. Try again in a moment." : error.message);
      }
      throw error;
    }
    model = answer.model;
    usage = answer.usage;
    const parsed = aiEditPlanSchema.safeParse(answer.json);
    if (!parsed.success) {
      console.error("ai edit: answer did not fit the plan schema", parsed.error.issues.slice(0, 3));
      return fail("The model's answer did not make sense for this reel. Try putting it another way.");
    }
    plan = parsed.data;
  }

  // "Face the door": the thing named is found in the 360 photo before the plan is applied (ADR 0025).
  for (const op of plan.ops) {
    if (op.op !== "turn" || op.yaw !== null || !op.content || !op.clip) continue;
    const clip = input.timeline.clips[op.clip - 1];
    if (!clip?.pano) continue;
    const aimed = await aimPano(input.user.workspaceId, clip.assetId, op.content);
    if (aimed) {
      op.yaw = aimed.heading;
      op.content = aimed.what;
    }
  }
  const result = applyAiEditPlan(input.timeline, plan, { assets, songs, unused, newId: () => crypto.randomUUID(), namedCuts: namesCuts(request) });
  const record = await prisma.aiEdit.update({
    where: { id: recordId },
    data: {
      request: answers.length ? `${request}${asked}` : request,
      note: plan.note,
      // The reservation key stays with the row, so a replay after it finished is still not charged again.
      plan: input.reservationKey ? { ...plan, reservation: input.reservationKey } : plan,
      applied: result.applied,
      skipped: result.skipped,
      model,
      inputTokens: usage.inputTokens,
      cachedTokens: usage.cachedTokens,
      outputTokens: usage.outputTokens,
    },
    select: { id: true },
  });
  if (model !== "fake") {
    console.log(`ai edit ${record.id}: ${model}, ${usage.inputTokens} in (${usage.cachedTokens} cached), ${usage.outputTokens} out, $${usageCostUsd(aiModel(), usage).toFixed(4)}, ${result.applied.length} applied, ${result.skipped.length} skipped`);
  }
  return { ok: true, timeline: result.timeline, note: plan.note, applied: result.applied, skipped: result.skipped, questions: plan.questions, editId: record.id, instagramPick: result.instagramPick, caption: result.caption };
}

/** One line for the account page: "4 of 60 this month". */
export async function aiEditUsage(workspaceId: string): Promise<{ used: number; allowed: number } | null> {
  if (!isAiAvailable()) return null;
  const [{ plan }, used] = await Promise.all([workspacePlan(workspaceId), aiEditsThisMonth(workspaceId)]);
  return { used, allowed: plan.aiEditsPerMonth };
}
