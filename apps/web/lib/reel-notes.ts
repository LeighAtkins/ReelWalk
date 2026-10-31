import { z } from "zod";
import { prisma } from "@reelwalk/db";
import { runAsUser, type ActingUser } from "./mcp/acting-user";
import { allow } from "./mcp/http";
import { STYLE_HINTS, TOOLS, runTool, type Gate, type ToolResult, type ToolSpec } from "./mcp/tools";
import type { Scope } from "./mcp/scopes";
import { addUsage, aiProvider, claudeToolTurn, usageCostUsd, type AiUsage, type ToolTurn, type ToolTurnBlock, type ToolTurnMessage, type ToolTurnOptions, type ToolTurnTool } from "./openai";

/**
 * Notes on a version (ADR 0095). The owner watches vN on the export screen
 * and types a note; Opus edits the reel with the connector's own tools (ADR
 * 0077), on the server, as that person. The app then exports v(n+1).
 *
 * What the agent can reach is decided here, not by the prompt:
 *  - only the tools in NOTE_TOOLS (reading, frames, checks, the sound, and
 *    apply_commands). Never generate_ai_shot, never the AI video route, never
 *    an export: nothing here can spend a credit or post;
 *  - only the scopes in NOTE_SCOPES (no `exports`, no `ai:generate`), so even
 *    a tool that slipped into the list would be refused by `runTool`;
 *  - only this reel and its own exports;
 *  - a saved change only after a dry run of exactly the same commands;
 *  - at most NOTE_MAX_CALLS tool calls; then it must answer.
 */

export const NOTE_TOOLS = ["get_reel", "get_brand_kit", "list_media", "get_audio_trace", "get_frames", "get_checks", "apply_commands", "add_voiceover"] as const;
export const NOTE_SCOPES: Scope[] = ["reels:read", "reels:write"];
export const NOTE_MAX_CALLS = 12;

/**
 * Create (ADR 0098): the same agent, run on a new reel whose first "note" is
 * the owner's idea. It may also find footage: search stock and import it, or
 * place library media (the owner's uploads, the starter library). It still
 * cannot make AI video, export or post, and add_media is bound to this reel
 * and to its stock and library modes.
 */
export const CREATE_TOOLS = ["get_reel", "get_brand_kit", "list_media", "search_stock", "add_media", "apply_commands", "add_voiceover"] as const;
export const CREATE_MAX_CALLS = 24;

export type NoteMode = "note" | "create";
const toolsFor = (mode: NoteMode): readonly string[] => (mode === "create" ? CREATE_TOOLS : NOTE_TOOLS);
const maxCallsFor = (mode: NoteMode) => (mode === "create" ? CREATE_MAX_CALLS : NOTE_MAX_CALLS);

const reelBound = new Set(["get_reel", "get_audio_trace", "apply_commands", "add_media", "add_voiceover"]);
const exportBound = new Set(["get_frames", "get_checks"]);

export const NOTE_INSTRUCTIONS = [
  "You are the editor inside ReelWalk's export screen. The owner of a short vertical reel watched its latest version and wrote a note. Change the reel's cut so the next version answers the note, using only the tools you have.",
  "Work like this: read the reel with get_reel. When the note is about what is on screen (what shows when, framing, titles), look at the latest export with get_frames: one contact sheet, at most 8 times, at the moments that matter. Then run apply_commands with dryRun true, read what it would change, and apply exactly the same commands with dryRun false and the revision you read. One saved batch is best; a 409 means the reel changed, so read it again.",
  "Change only what the note asks for, and keep everything else as it is. Times are in milliseconds in the tools; trims keep a clip inside its source; a clip's sourceWindowMs is where it starts and ends in its file, so starting a clip later in its file shows what comes later sooner.",
  "Even a reel that is one long rendered clip can be re-cut: splitClip and moveClip put a later moment first, trimClip drops a stretch, setSpeed and retime change pace. Look at the frames, and when the note can be met by reordering, trimming or timing what is already filmed, do that. What is drawn inside a frame (its framing, a title burnt into the video) cannot change.",
  "You cannot export, post, schedule, add new footage or make AI video, and you do not need to: the app renders the new version after you finish. If the note needs any of those, or a change inside the pictures themselves, change nothing and say so plainly. A note that asks for a spoken voiceover (or a different voice or script) is met with add_voiceover; one that asks to remove it, with apply_commands setVoiceover{voiceover:null}.",
  `You have at most ${NOTE_MAX_CALLS} tool calls.`,
  "Finish with one or two plain sentences to the owner, no markdown: what you changed, with times in seconds, or why you changed nothing.",
  STYLE_HINTS,
].join("\n\n");

export const CREATE_INSTRUCTIONS = [
  "You are the editor inside ReelWalk. The owner typed an idea for a short vertical Instagram reel and you make its first version on the reel you are given, using only the tools you have. Short and punchy: 10 to 25 seconds, 5 to 10 shots, something moving or changing inside the first second.",
  "Footage first. Read the reel with get_reel: media the owner uploaded for this idea is already on it, so build around that and keep it. When it has none, or too little for the idea, find more: search_stock with specific, visual queries (portrait clips; people and burnt-in text are left out unless you ask), then import the clips you will use with add_media mode stock (they land on the end of this reel); or list_media with includeStarter true and place library media with add_media mode library. Prefer clips from one stock group so they cut together. Import only what you will use.",
  "Then cut it with apply_commands: drop or trim what does not serve the idea, order the shots so the strongest is first, pace it, and set music from the library (list_media kind AUDIO, includeStarter true) with setMusic. Run each batch with dryRun true first, then apply exactly the same commands with dryRun false and the revision you read; a 409 means the reel changed, so read it again.",
  "Words on screen follow the brief: with captions on, a hook title on screen from frame 0 and three to six short text beats across the reel that carry the message (the brief's offer, place or call to action), each under seven words; with captions off, only the hook title. Never invent facts the idea does not give (prices, addresses, numbers).",
  "Voiceover follows the brief: when it names a voice, write a script of two to four short spoken sentences (under 60 words) that carries the idea, and add it with add_voiceover in that voice, after the cut is set (it lengthens the reel to fit and saves a revision; read the reel again after it). Its captions then carry the words, so keep the hook title and drop text beats that would repeat them. With no voice in the brief, add no voiceover.",
  "You cannot make AI video, export, post or schedule: the app exports the version after you finish, and the owner posts it. If the idea needs footage nothing here can supply, make the best honest version from what there is and say what would make it better.",
  `You have at most ${CREATE_MAX_CALLS} tool calls.`,
  "Finish with one or two plain sentences to the owner, no markdown: what the reel shows and how it is cut. Then a last line that starts with \"Caption:\" and holds the Instagram caption: under 300 characters, plain words, three to five relevant hashtags at the end.",
  STYLE_HINTS,
].join("\n\n");

/** The caption line a create run ends with, split from the reply the owner reads. */
export function splitCaption(reply: string): { reply: string; caption: string | null } {
  const match = /^[ \t]*Caption:[ \t]*/im.exec(reply);
  if (!match) return { reply: reply.trim(), caption: null };
  const caption = reply.slice(match.index + match[0].length).trim().slice(0, 2200);
  return { reply: reply.slice(0, match.index).trim(), caption: caption || null };
}

export type NoteCall = { tool: string; ok: boolean; dryRun?: boolean; refused?: string };

export type NoteOutcome = {
  reply: string;
  /** True when a batch was saved: the reel has a new revision to export. */
  changed: boolean;
  revisionBefore: number;
  revisionAfter: number;
  /** The saved commands, one short line each. */
  applied: string[];
  calls: NoteCall[];
  usage: AiUsage;
  model: string;
  costUsd: number;
};

export type NoteDeps = {
  turn: (options: ToolTurnOptions) => Promise<ToolTurn>;
  gate: Gate;
  tools: ToolSpec[];
};

/** The connector tools a note (or a create run) may use, in a fixed order (it is part of the cached prefix). */
export function noteToolSpecs(all: ToolSpec[] = TOOLS, mode: NoteMode = "note"): ToolSpec[] {
  const specs = toolsFor(mode).map((name) => all.find((spec) => spec.name === name)).filter((spec): spec is ToolSpec => Boolean(spec));
  // Belt and braces: nothing that spends credits or exports, whatever the list says.
  return specs.filter((spec) => !spec.scopes.some((scope) => scope === "ai:generate" || scope === "exports"));
}

/** A tool as Claude sees it: its description and its zod shape as JSON schema (what a model may send, defaults optional). */
export function toClaudeTool(spec: ToolSpec): ToolTurnTool {
  const { $schema: _schema, ...schema } = z.toJSONSchema(z.object(spec.input), { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  void _schema;
  return { name: spec.name, description: spec.description, input_schema: schema };
}

/** An MCP tool result as the content of a Claude tool_result block. */
export function toToolResultContent(result: ToolResult): ToolTurnBlock[] {
  return result.content.map((item): ToolTurnBlock => {
    if (item.type === "image") return { type: "image", source: { type: "base64", media_type: item.mimeType, data: item.data } };
    if (item.type === "text") return { type: "text", text: item.text };
    return { type: "text", text: JSON.stringify(item) };
  });
}

type CallState = { reelId: string; exportIds: Set<string>; dryRuns: Set<string>; calls: number; mode?: NoteMode };

/** A dry run approves exactly this command list at exactly this revision; any other revision needs a new dry run. */
export const approvalKey = (revision: unknown, commands: unknown) => `${String(revision)}|${JSON.stringify(commands ?? null)}`;

/**
 * Whether one call may run, and its arguments bound to this reel. Returns the
 * reason when it may not. Pure apart from the state it is given.
 */
export function checkCall(state: CallState, name: string, raw: Record<string, unknown>): { ok: true; args: Record<string, unknown> } | { ok: false; reason: string } {
  const mode = state.mode ?? "note";
  const allowed = toolsFor(mode);
  const max = maxCallsFor(mode);
  if (!allowed.includes(name)) return { ok: false, reason: `${name} is not available here. Use only: ${allowed.join(", ")}.` };
  if (state.calls >= max) return { ok: false, reason: `All ${max} tool calls are used. Answer the owner now.` };
  const args = { ...raw };
  if (name === "add_media" && args.mode !== "stock" && args.mode !== "library") return { ok: false, reason: "add_media takes mode stock or library here." };
  if (reelBound.has(name)) {
    if (args.reelId !== undefined && args.reelId !== state.reelId) return { ok: false, reason: `Notes work on reel ${state.reelId} only.` };
    args.reelId = state.reelId;
  }
  if (exportBound.has(name) && !state.exportIds.has(String(args.exportId))) return { ok: false, reason: `That is not an export of this reel. Its exports are: ${[...state.exportIds].join(", ") || "none"}.` };
  if (name === "apply_commands" && args.dryRun !== true) {
    if (typeof args.revision !== "number") return { ok: false, reason: "Pass the revision you read (get_reel) when applying." };
    if (!state.dryRuns.has(approvalKey(args.revision, args.commands))) return { ok: false, reason: `Run these exact commands with dryRun: true at revision ${args.revision} first, then apply the same list at that revision.` };
  }
  return { ok: true, args };
}

/** Tools other than apply_commands whose successful call saves a revision of the reel. */
const SAVING_TOOLS = new Set(["add_media", "add_voiceover"]);

/** One line for the record of a save made by add_media or add_voiceover. */
export function describeToolSave(name: string, args: Record<string, unknown>): string {
  if (name === "add_voiceover") return `add_voiceover ${String(args.voice ?? "default voice")} "${String(args.script ?? "").slice(0, 120)}"`;
  const ids = (Array.isArray(args.stockIds) ? args.stockIds : Array.isArray(args.mediaIds) ? args.mediaIds : []) as unknown[];
  return `add_media ${String(args.mode)} ${ids.length} item(s)`;
}

/** The revision a saving tool's answer says it saved, or null when it saved none. */
export function savedRevision(name: string, json: Record<string, unknown>): number | null {
  if (name === "add_voiceover") return typeof json.revision === "number" ? json.revision : null;
  const added = json.addedToReel as { revision?: unknown } | null | undefined;
  return typeof added?.revision === "number" ? added.revision : null;
}

/** The answer of a tool result as JSON, when its first part is the usual `{ ok, ... }` text. */
function resultJson(result: ToolResult): Record<string, unknown> | null {
  const first = result.content[0];
  if (first?.type !== "text") return null;
  try {
    return JSON.parse(first.text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** One saved command as a short line for the thread and the record: its type and its fields. */
export function describeCommand(command: unknown): string {
  if (!command || typeof command !== "object") return String(command);
  const { type, ...fields } = command as { type?: unknown } & Record<string, unknown>;
  const rest = JSON.stringify(fields);
  return `${String(type)} ${rest.length > 160 ? `${rest.slice(0, 157)}...` : rest}`;
}

const refusal = (reason: string): ToolResult => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, message: reason }) }] });

/** What the note agent is told about the reel, its versions and the earlier notes. */
export function noteBrief(input: { title: string; reelId: string; revision: number; versions: { label: string; exportId: string; status: string }[]; history: { note: string; reply: string }[]; note: string }): string {
  const lines = [
    `Reel "${input.title}" (id ${input.reelId}), revision ${input.revision}.`,
    `Its versions, newest last: ${input.versions.map((version) => `${version.label} = export ${version.exportId} (${version.status})`).join("; ") || "none exported yet"}.`,
  ];
  if (input.history.length) lines.push(`Earlier notes on this reel, oldest first:\n${input.history.map((entry) => `- "${entry.note}" -> ${entry.reply}`).join("\n")}`);
  lines.push(`The owner's note on the latest version:\n"""\n${input.note}\n"""`);
  return lines.join("\n\n");
}

export type NoteGuards = {
  /** Epoch ms after which the note stops: no further model turn, no save. */
  deadline?: number;
  /** Asked before every save; a reason refuses the save (the note was stopped or is out of time). */
  beforeSave?: () => Promise<string | null>;
  /** Told the lines of a save just before it is attempted, so the save's own transaction can record them (ADR 0095). */
  onApplying?: (lines: string[]) => void;
  /** Told after every save. */
  onSaved?: (saved: { revisionAfter: number; applied: string[] }) => Promise<void>;
};

/** A note that stopped part-way: `partial` is what it had done (saves, calls, tokens) when it stopped. */
export class NoteRunError extends Error {
  constructor(message: string, public readonly partial: NoteOutcome) {
    super(message);
    this.name = "NoteRunError";
  }
}

/**
 * Runs one note: Opus and the tools, until it answers or the calls run out.
 * Runs as `user` (getSessionUser answers with them inside, as on /mcp). A
 * failure part-way (the provider, a tool, the deadline) throws NoteRunError
 * with what was already saved and spent.
 */
export async function runNote(input: { user: ActingUser; reelId: string; note: string; origin: string; brief: string; exportIds: string[]; revision: number; mode?: NoteMode } & NoteGuards, deps: NoteDeps = { turn: claudeToolTurn, gate: allow, tools: noteToolSpecs() }): Promise<NoteOutcome> {
  return runAsUser(input.user, async () => {
    const mode = input.mode ?? "note";
    const maxCalls = maxCallsFor(mode);
    // Turns allowed: every call could come alone, plus the answer and one nudge.
    const maxTurns = maxCalls + 2;
    const system = mode === "create" ? CREATE_INSTRUCTIONS : NOTE_INSTRUCTIONS;
    const ctx = { user: input.user, scopes: NOTE_SCOPES, origin: input.origin };
    const specs = new Map(deps.tools.map((spec) => [spec.name, spec]));
    const tools = deps.tools.map(toClaudeTool);
    const state: CallState = { reelId: input.reelId, exportIds: new Set(input.exportIds), dryRuns: new Set(), calls: 0, mode };
    const messages: ToolTurnMessage[] = [{ role: "user", content: [{ type: "text", text: input.brief }] }];
    const calls: NoteCall[] = [];
    const applied: string[] = [];
    let usage: AiUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheWriteTokens: 0 };
    let model = "";
    let revisionAfter = input.revision;
    let reply = "";
    const snapshot = (): NoteOutcome => {
      const changed = revisionAfter !== input.revision;
      return {
        reply: reply || (changed ? "Done." : "I could not work out a change for that note."),
        changed,
        revisionBefore: input.revision,
        revisionAfter,
        applied: [...applied],
        calls: [...calls],
        usage,
        model,
        costUsd: model ? usageCostUsd(model, usage, { provider: aiProvider() }) : 0,
      };
    };

    try {
      for (let turnNo = 0; turnNo < maxTurns; turnNo++) {
        const left = input.deadline === undefined ? 180_000 : input.deadline - Date.now();
        if (left <= 0) throw new Error("The note ran out of time.");
        const out = state.calls >= maxCalls;
        const answer = await deps.turn({ workspaceId: input.user.workspaceId, system, tools, messages, toolChoice: out ? "none" : "auto", signal: AbortSignal.timeout(Math.min(180_000, left)) });
        usage = addUsage(usage, answer.usage);
        model = answer.model;
        // The answer goes back exactly as it came, thinking blocks included.
        messages.push({ role: "assistant", content: answer.content });
        const uses = answer.content.filter((block) => block.type === "tool_use") as Array<ToolTurnBlock & { id: string; name: string; input: Record<string, unknown> }>;
        if (answer.stopReason !== "tool_use" || uses.length === 0) {
          reply = answer.content.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join(" ").trim();
          if (answer.stopReason === "max_tokens" && !reply) reply = "I ran out of room before finishing.";
          break;
        }
        const results: ToolTurnBlock[] = [];
        for (const use of uses) {
          const checked = checkCall(state, use.name, use.input ?? {});
          let result: ToolResult;
          const saving = checked.ok && use.name === "apply_commands" && checked.args.dryRun !== true;
          const fenced = saving ? await input.beforeSave?.() : null;
          if (!checked.ok || fenced) {
            const reason = checked.ok ? fenced! : checked.reason;
            calls.push({ tool: use.name, ok: false, refused: reason });
            result = refusal(reason);
          } else {
            state.calls++;
            const spec = specs.get(use.name)!;
            if (saving) input.onApplying?.(Array.isArray(checked.args.commands) ? checked.args.commands.map(describeCommand) : []);
            const toolSave = SAVING_TOOLS.has(use.name) ? describeToolSave(use.name, checked.args) : null;
            if (toolSave) input.onApplying?.([toolSave]);
            const parsed = z.object(spec.input).safeParse(checked.args);
            result = parsed.success ? await runTool(spec, ctx, parsed.data as Record<string, unknown>, deps.gate) : refusal(`The arguments do not fit ${spec.name}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
            const json = resultJson(result);
            const dryRun = use.name === "apply_commands" ? checked.args.dryRun === true : undefined;
            calls.push({ tool: use.name, ok: !result.isError, ...(dryRun !== undefined ? { dryRun } : {}) });
            // add_media (onto the reel) and add_voiceover save a revision too: the version exported is the last one saved.
            const toolRevision = toolSave && !result.isError && json ? savedRevision(use.name, json) : null;
            if (toolSave && toolRevision !== null) {
              revisionAfter = toolRevision;
              applied.push(toolSave);
              state.dryRuns.clear();
              await input.onSaved?.({ revisionAfter, applied: [...applied] });
            }
            if (use.name === "apply_commands" && !result.isError && json) {
              // The approval is for the revision the dry run checked against (its answer's revision).
              if (dryRun) state.dryRuns.add(approvalKey(json.revision, checked.args.commands));
              else {
                revisionAfter = typeof json.revision === "number" ? json.revision : revisionAfter;
                applied.push(...(Array.isArray(checked.args.commands) ? checked.args.commands.map(describeCommand) : []));
                // A new revision: every earlier approval is for a cut that no longer exists.
                state.dryRuns.clear();
                await input.onSaved?.({ revisionAfter, applied: [...applied] });
              }
            }
          }
          results.push({ type: "tool_result", tool_use_id: use.id, content: toToolResultContent(result), ...(result.isError ? { is_error: true } : {}) });
        }
        if (state.calls >= maxCalls) results.push({ type: "text", text: `That was the last of your ${maxCalls} tool calls. Answer the owner now.` });
        messages.push({ role: "user", content: results });
      }
    } catch (error) {
      throw new NoteRunError(error instanceof Error ? error.message : String(error), snapshot());
    }
    return snapshot();
  });
}

/** A reel's REEL exports as the versions v1, v2, …: the `last` newest (all by default), oldest first, numbered from the first ever. */
export async function reelVersions(workspaceId: string, reelId: string, options: { last?: number } = {}) {
  const where = { workspaceId, reelId, kind: "REEL" as const };
  const [total, newest] = await Promise.all([
    prisma.renderJob.count({ where }),
    prisma.renderJob.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], ...(options.last ? { take: options.last } : {}), select: { id: true, status: true, createdAt: true } }),
  ]);
  const jobs = newest.reverse();
  return jobs.map((job, index) => {
    const n = total - jobs.length + index + 1;
    return { ...job, n, label: `v${n}` };
  });
}

// ── The stand-in (DEV_FAKE_AI) ───────────────────────────────────

const lastToolJson = (messages: ToolTurnMessage[]): Record<string, unknown> | null => {
  const results = messages[messages.length - 1]?.content.filter((block) => block.type === "tool_result") ?? [];
  const text = (results[0]?.content as ToolTurnBlock[] | undefined)?.find((block) => block.type === "text")?.text;
  try {
    return typeof text === "string" ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * A rule-based stand-in for Opus, for e2e and local runs without a model: it
 * goes through the same tools and guards. "bigger" scales every title by a
 * quarter; "earlier" starts the first clip a second later in its file. It
 * reads the reel, dry-runs, applies the same list, then answers.
 */
export async function fakeNoteTurn(options: ToolTurnOptions): Promise<ToolTurn> {
  const usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheWriteTokens: 0 };
  const turns = options.messages.filter((message) => message.role === "assistant").length;
  const note = /"""\n([\s\S]*?)\n"""/.exec(String(options.messages[0]?.content[0]?.text ?? ""))?.[1]?.toLowerCase() ?? "";
  const use = (name: string, input: Record<string, unknown>): ToolTurn => ({ content: [{ type: "tool_use", id: `fake-${turns}`, name, input }], stopReason: "tool_use", usage, model: "fake" });
  const say = (text: string): ToolTurn => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage, model: "fake" });
  if (turns === 0) return use("get_reel", {});
  const json = lastToolJson(options.messages);
  if (turns === 1) {
    const texts = (json?.texts as { id: string; size: number }[] | undefined) ?? [];
    const clips = (json?.clips as { id: string; sourceWindowMs: [number, number] }[] | undefined) ?? [];
    let commands: Record<string, unknown>[] = [];
    if (/bigger|larger/.test(note) && texts.length) commands = texts.map((text) => ({ type: "updateText", textId: text.id, patch: { size: Math.round(text.size * 125) / 100 } }));
    else if (/earlier|sooner/.test(note) && clips.length) {
      const [start, end] = clips[0].sourceWindowMs;
      const shift = Math.min(1000, Math.floor((end - start) / 3));
      if (shift > 0) commands = [{ type: "trimClip", clipId: clips[0].id, window: { sourceStartMs: start + shift, sourceEndMs: end } }];
    }
    if (!commands.length) return say("I could not tell what to change from that note, so the reel is as it was.");
    return use("apply_commands", { commands, dryRun: true, revision: json?.revision });
  }
  const previous = options.messages[options.messages.length - 2]?.content.find((block) => block.type === "tool_use") as { input?: Record<string, unknown> } | undefined;
  if (turns === 2 && json?.ok && previous?.input?.dryRun) return use("apply_commands", { ...previous.input, dryRun: false });
  if (json?.ok) return say(`Done: ${((json.changes as string[] | undefined) ?? []).join(" ") || "the change is in"}.`);
  return say(`That did not work: ${String(json?.message ?? "unknown")}`);
}

/**
 * The stand-in for a create run (DEV_FAKE_AI): it reads the reel, puts the
 * idea's first words on as the hook title (dry run, then the same batch), and
 * answers with a caption line. It finds no footage of its own.
 */
export async function fakeCreateTurn(options: ToolTurnOptions): Promise<ToolTurn> {
  const usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheWriteTokens: 0 };
  const turns = options.messages.filter((message) => message.role === "assistant").length;
  const idea = /"""\n([\s\S]*?)\n"""/.exec(String(options.messages[0]?.content[0]?.text ?? ""))?.[1] ?? "";
  const use = (name: string, input: Record<string, unknown>): ToolTurn => ({ content: [{ type: "tool_use", id: `fake-${turns}`, name, input }], stopReason: "tool_use", usage, model: "fake" });
  const say = (text: string): ToolTurn => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage, model: "fake" });
  if (turns === 0) return use("get_reel", {});
  const json = lastToolJson(options.messages);
  if (turns === 1) {
    if (!((json?.clips as unknown[] | undefined) ?? []).length) return say(`There is no footage on this reel yet, so I made nothing.\nCaption: ${idea.slice(0, 120)}`);
    const hook = idea.split(/\s+/).filter(Boolean).slice(0, 5).join(" ") || "New reel";
    return use("apply_commands", { commands: [{ type: "addText", text: { id: "create-hook", text: hook, startMs: 0, x: 0.5, y: 0.3, style: "elegant", size: 1 } }], dryRun: true, revision: json?.revision });
  }
  const previous = options.messages[options.messages.length - 2]?.content.find((block) => block.type === "tool_use") as { input?: Record<string, unknown> } | undefined;
  if (turns === 2 && json?.ok && previous?.input?.dryRun) return use("apply_commands", { ...previous.input, dryRun: false });
  if (json?.ok) return say(`Your footage with the idea as the opening title.\nCaption: ${idea.slice(0, 120)} #realestate #newlisting #hometour`);
  return say(`That did not work: ${String(json?.message ?? "unknown")}`);
}
