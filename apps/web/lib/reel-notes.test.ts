/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@reelwalk/db", () => ({ prisma: {} }));
// Notes never spend: the AI gate is on for the test workspace, and no provider is called.
vi.mock("./ai-gate", () => ({ aiIsOff: async () => false, assertAiOn: async () => undefined, AI_OFF_CODE: "ai_off", AI_OFF_MESSAGE: "off" }));

import type { ToolResult, ToolSpec } from "./mcp/tools";
import { TOOLS } from "./mcp/tools";
import type { ToolTurn, ToolTurnBlock, ToolTurnOptions } from "./openai";
import { NOTE_MAX_CALLS, NOTE_SCOPES, NOTE_TOOLS, NoteRunError, approvalKey, checkCall, fakeNoteTurn, noteBrief, noteToolSpecs, runNote, toClaudeTool, toToolResultContent } from "./reel-notes";

const user = { id: "u1", workspaceId: "w1" } as any;
const usage = { inputTokens: 1000, cachedTokens: 400, outputTokens: 100, cacheWriteTokens: 0 };
const okText = (data: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }) }] });

/** Stub tools with the real names and shapes, recording what ran. */
function stubTools(ran: { name: string; args: Record<string, unknown> }[], reel = { revision: 3, texts: [{ id: "t1", size: 1 }], clips: [{ id: "c1", sourceWindowMs: [0, 6000] }] }) {
  return noteToolSpecs().map((spec): ToolSpec => ({
    ...spec,
    limits: undefined,
    async run(_ctx, args) {
      ran.push({ name: spec.name, args });
      if (spec.name === "get_reel") return okText({ ...reel, reelId: args.reelId });
      if (spec.name === "apply_commands") return okText({ dryRun: args.dryRun, revision: args.dryRun ? reel.revision : reel.revision + 1, changes: ["Title 1 is bigger."] });
      return okText({});
    },
  }));
}

/** A model that plays the given turns in order. */
function scripted(turns: ((options: ToolTurnOptions) => ToolTurnBlock[] | string)[]) {
  const seen: ToolTurnOptions[] = [];
  const turn = async (options: ToolTurnOptions): Promise<ToolTurn> => {
    seen.push(structuredClone(options));
    const next = turns[seen.length - 1]?.(options) ?? "done";
    return typeof next === "string"
      ? { content: [{ type: "text", text: next }], stopReason: "end_turn", usage, model: "claude-opus-5-5" }
      : { content: next, stopReason: "tool_use", usage, model: "claude-opus-5-5" };
  };
  return { turn, seen };
}
const use = (name: string, input: Record<string, unknown>, id = `${name}-${Math.random()}`): ToolTurnBlock => ({ type: "tool_use", id, name, input });
const base = { user, reelId: "r1", note: "make the titles bigger", origin: "https://x", brief: "brief", exportIds: ["e1"], revision: 3 };
const always = async () => true;

describe("what a note can reach", () => {
  it("is the reading tools and apply_commands, never AI video, stock, uploads or exports", () => {
    const names = noteToolSpecs(TOOLS).map((spec) => spec.name);
    expect(names).toEqual([...NOTE_TOOLS]);
    for (const banned of ["generate_ai_shot", "get_ai_shot", "export_reel", "get_export", "add_media", "search_stock", "create_reel", "list_reels", "list_workspaces"]) expect(names).not.toContain(banned);
    expect(NOTE_SCOPES).not.toContain("ai:generate");
    expect(NOTE_SCOPES).not.toContain("exports");
  });

  it("drops a credit-spending tool even if the list names it", () => {
    const spender = TOOLS.find((spec) => spec.name === "generate_ai_shot")!;
    expect(noteToolSpecs([{ ...spender, name: "get_reel" }])).toEqual([]);
  });

  it("refuses tools off the list, other reels and other reels' exports", () => {
    const state = { reelId: "r1", exportIds: new Set(["e1"]), dryRuns: new Set<string>(), calls: 0 };
    expect(checkCall(state, "generate_ai_shot", { prompt: "a pool at dusk", confirmCredits: 1 })).toMatchObject({ ok: false });
    expect(checkCall(state, "export_reel", { reelId: "r1" })).toMatchObject({ ok: false });
    expect(checkCall(state, "get_reel", { reelId: "r2" })).toMatchObject({ ok: false });
    expect(checkCall(state, "get_reel", {})).toEqual({ ok: true, args: { reelId: "r1" } });
    expect(checkCall(state, "get_frames", { exportId: "e9", times: [0] })).toMatchObject({ ok: false });
    expect(checkCall(state, "get_frames", { exportId: "e1", times: [0] })).toMatchObject({ ok: true });
  });

  it("saves only what was dry-run first, at a revision", () => {
    const state = { reelId: "r1", exportIds: new Set<string>(), dryRuns: new Set<string>(), calls: 0 };
    const commands = [{ type: "updateText", textId: "t1", patch: { size: 1.25 } }];
    expect(checkCall(state, "apply_commands", { commands, revision: 3 })).toMatchObject({ ok: false, reason: expect.stringContaining("dryRun") });
    expect(checkCall(state, "apply_commands", { commands, dryRun: true })).toMatchObject({ ok: true });
    state.dryRuns.add(approvalKey(3, commands));
    expect(checkCall(state, "apply_commands", { commands })).toMatchObject({ ok: false, reason: expect.stringContaining("revision") });
    expect(checkCall(state, "apply_commands", { commands, revision: 3 })).toMatchObject({ ok: true });
    expect(checkCall(state, "apply_commands", { commands: [{ type: "deleteClip", clipId: "c1" }], revision: 3 })).toMatchObject({ ok: false });
  });

  it("approves a dry run for its revision only: after the reel moves on, the same commands need a new dry run", () => {
    const state = { reelId: "r1", exportIds: new Set<string>(), dryRuns: new Set<string>([approvalKey(3, [{ type: "splitClip", atMs: 6000, newId: "a" }])]), calls: 0 };
    // The owner saved (revision 4) and the agent re-read: an absolute-time split checked at 3 must not land on 4.
    expect(checkCall(state, "apply_commands", { commands: [{ type: "splitClip", atMs: 6000, newId: "a" }], revision: 4 })).toMatchObject({ ok: false, reason: expect.stringContaining("revision 4") });
    expect(checkCall(state, "apply_commands", { commands: [{ type: "splitClip", atMs: 6000, newId: "a" }], revision: 3 })).toMatchObject({ ok: true });
  });

  it("stops at the call limit", () => {
    const state = { reelId: "r1", exportIds: new Set<string>(), dryRuns: new Set<string>(), calls: NOTE_MAX_CALLS };
    expect(checkCall(state, "get_reel", {})).toMatchObject({ ok: false, reason: expect.stringContaining("Answer") });
  });
});

describe("the tools as Claude sees them", () => {
  it("are JSON schemas with optional defaults", () => {
    const apply = toClaudeTool(noteToolSpecs().find((spec) => spec.name === "apply_commands")!);
    expect(apply.input_schema.type).toBe("object");
    expect(Object.keys(apply.input_schema.properties as object)).toEqual(expect.arrayContaining(["reelId", "commands", "revision", "dryRun"]));
    expect(apply.input_schema.required).toEqual(expect.arrayContaining(["reelId", "commands"]));
    expect(apply.input_schema.required).not.toContain("dryRun");
    expect(apply.input_schema).not.toHaveProperty("$schema");
  });

  it("get frames back as image blocks", () => {
    const content = toToolResultContent({ content: [{ type: "text", text: "{}" }, { type: "image", data: "AAAA", mimeType: "image/jpeg" }] });
    expect(content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } });
  });
});

describe("running a note", () => {
  it("reads, dry-runs, applies the same list, and reports the change and its cost", async () => {
    const ran: { name: string; args: Record<string, unknown> }[] = [];
    const commands = [{ type: "updateText", textId: "t1", patch: { size: 1.25 } }];
    const { turn, seen } = scripted([
      () => [use("get_reel", {})],
      () => [use("apply_commands", { commands, dryRun: true })],
      () => [use("apply_commands", { commands, revision: 3 })],
      () => "The title is a quarter bigger from 0 s.",
    ]);
    const out = await runNote(base, { turn, gate: always, tools: stubTools(ran) });
    expect(ran.map((call) => call.name)).toEqual(["get_reel", "apply_commands", "apply_commands"]);
    expect(ran[0].args.reelId).toBe("r1");
    expect(out).toMatchObject({ changed: true, revisionBefore: 3, revisionAfter: 4, applied: ['updateText {"textId":"t1","patch":{"size":1.25}}'], reply: "The title is a quarter bigger from 0 s.", model: "claude-opus-5-5" });
    expect(out.calls).toEqual([{ tool: "get_reel", ok: true }, { tool: "apply_commands", ok: true, dryRun: true }, { tool: "apply_commands", ok: true, dryRun: false }]);
    // 4 turns of 1000 in (400 cached) and 100 out at Opus 5.5's list price.
    expect(out.usage).toMatchObject({ inputTokens: 4000, cachedTokens: 1600, outputTokens: 400 });
    expect(out.costUsd).toBeCloseTo((2400 * 4 + 1600 * 0.2 + 400 * 20) / 1e6, 6);
    // Append-only: each turn sends the earlier turns unchanged, the model's own blocks included.
    expect(seen[3].messages.slice(0, seen[2].messages.length)).toEqual(seen[2].messages);
    expect(seen.every((options) => options.toolChoice === "auto")).toBe(true);
  });

  it("answers a credit-spending call with an error and runs nothing", async () => {
    const ran: { name: string; args: Record<string, unknown> }[] = [];
    const { turn, seen } = scripted([() => [use("generate_ai_shot", { prompt: "a desk at dusk, slow push", confirmCredits: 1 }, "x1")], () => "I cannot make AI video from a note."]);
    const out = await runNote(base, { turn, gate: always, tools: stubTools(ran) });
    expect(ran).toEqual([]);
    expect(out.changed).toBe(false);
    expect(out.calls).toEqual([{ tool: "generate_ai_shot", ok: false, refused: expect.stringContaining("not available") }]);
    const result = seen[1].messages[2].content[0] as any;
    expect(result).toMatchObject({ type: "tool_result", tool_use_id: "x1", is_error: true });
  });

  it("refuses an apply that skipped the dry run, so nothing is saved", async () => {
    const ran: { name: string; args: Record<string, unknown> }[] = [];
    const { turn } = scripted([() => [use("apply_commands", { commands: [{ type: "deleteClip", clipId: "c1" }], revision: 3 })], () => "Nothing changed."]);
    const out = await runNote(base, { turn, gate: always, tools: stubTools(ran) });
    expect(ran).toEqual([]);
    expect(out.changed).toBe(false);
  });

  it("asks for the answer without tools once the calls run out", async () => {
    const ran: { name: string; args: Record<string, unknown> }[] = [];
    const { turn, seen } = scripted([...Array.from({ length: NOTE_MAX_CALLS }, () => () => [use("get_reel", {})]), () => "I looked but changed nothing."]);
    const out = await runNote(base, { turn, gate: always, tools: stubTools(ran) });
    expect(ran).toHaveLength(NOTE_MAX_CALLS);
    expect(seen[NOTE_MAX_CALLS].toolChoice).toBe("none");
    expect(out.reply).toBe("I looked but changed nothing.");
  });

  it("after a 409 and a re-read, the old dry run does not let the same commands land on the new revision", async () => {
    const ran: { name: string; args: Record<string, unknown> }[] = [];
    const commands = [{ type: "splitClip", atMs: 6000, newId: "a" }];
    const reel = { revision: 3, texts: [], clips: [{ id: "c1", sourceWindowMs: [0, 12000] }] };
    const tools = stubTools(ran, reel as any).map((spec) => (spec.name === "apply_commands"
      ? { ...spec, async run(_ctx: any, args: any) { ran.push({ name: spec.name, args }); if (args.revision !== reel.revision) return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ ok: false, status: 409 }) }] }; return okText({ dryRun: args.dryRun, revision: args.dryRun ? reel.revision : reel.revision + 1, changes: [] }); } }
      : spec));
    const { turn } = scripted([
      () => [use("apply_commands", { commands, dryRun: true, revision: 3 })],
      () => { reel.revision = 4; return [use("apply_commands", { commands, revision: 3 })]; }, // the owner saved meanwhile: 409
      () => [use("apply_commands", { commands, revision: 4 })], // re-read, then tries the old approval at the new revision
      () => "Stopped.",
    ]);
    const out = await runNote(base, { turn, gate: always, tools });
    expect(ran.filter((call) => call.name === "apply_commands" && call.args.dryRun === false).map((call) => call.args.revision)).toEqual([3]);
    expect(out.calls[2]).toMatchObject({ tool: "apply_commands", ok: false, refused: expect.stringContaining("revision 4") });
    expect(out.changed).toBe(false);
  });

  it("an approval is spent by its save: the same list cannot be applied twice", async () => {
    const ran: { name: string; args: Record<string, unknown> }[] = [];
    const commands = [{ type: "updateText", textId: "t1", patch: { size: 1.25 } }];
    const { turn } = scripted([
      () => [use("apply_commands", { commands, dryRun: true })],
      () => [use("apply_commands", { commands, revision: 3 })],
      () => [use("apply_commands", { commands, revision: 3 })],
      () => "ok",
    ]);
    const out = await runNote(base, { turn, gate: always, tools: stubTools(ran) });
    expect(ran.filter((call) => call.name === "apply_commands")).toHaveLength(2);
    expect(out.calls[2].refused).toBeTruthy();
  });

  it("a failure after a save throws what was saved and spent, not nothing", async () => {
    const ran: { name: string; args: Record<string, unknown> }[] = [];
    const commands = [{ type: "updateText", textId: "t1", patch: { size: 1.25 } }];
    const saved: unknown[] = [];
    const { turn } = scripted([
      () => [use("apply_commands", { commands, dryRun: true })],
      () => [use("apply_commands", { commands, revision: 3 })],
      () => { throw new Error("Claude could not answer (HTTP 529)."); },
    ]);
    const error = await runNote({ ...base, onSaved: async (state) => void saved.push(state) }, { turn, gate: always, tools: stubTools(ran) }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NoteRunError);
    const partial = (error as NoteRunError).partial;
    expect(partial).toMatchObject({ changed: true, revisionAfter: 4, applied: ['updateText {"textId":"t1","patch":{"size":1.25}}'], model: "claude-opus-5-5" });
    expect(partial.usage.inputTokens).toBe(2000);
    expect(partial.costUsd).toBeGreaterThan(0);
    expect((error as Error).message).toContain("529");
    expect(saved).toEqual([{ revisionAfter: 4, applied: partial.applied }]);
  });

  it("stops at its deadline before asking the model again", async () => {
    const ran: { name: string; args: Record<string, unknown> }[] = [];
    const { turn, seen } = scripted([() => [use("get_reel", {})], () => "never"]);
    const error = await runNote({ ...base, deadline: Date.now() - 1 }, { turn, gate: always, tools: stubTools(ran) }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NoteRunError);
    expect((error as Error).message).toContain("out of time");
    expect(seen).toHaveLength(0);
  });

  it("asks before every save, and a refusal saves nothing", async () => {
    const ran: { name: string; args: Record<string, unknown> }[] = [];
    const commands = [{ type: "updateText", textId: "t1", patch: { size: 1.25 } }];
    const { turn } = scripted([() => [use("apply_commands", { commands, dryRun: true })], () => [use("apply_commands", { commands, revision: 3 })], () => "Stopped."]);
    const out = await runNote({ ...base, beforeSave: async () => "This note was stopped." }, { turn, gate: always, tools: stubTools(ran) });
    expect(ran.map((call) => call.args.dryRun)).toEqual([true]);
    expect(out.calls[1]).toMatchObject({ ok: false, refused: "This note was stopped." });
    expect(out.changed).toBe(false);
  });

  it("validates arguments against the tool's shape", async () => {
    const ran: { name: string; args: Record<string, unknown> }[] = [];
    const { turn, seen } = scripted([() => [use("get_frames", { exportId: "e1", times: "zero" }, "f1")], () => "ok"]);
    await runNote(base, { turn, gate: always, tools: stubTools(ran) });
    expect(ran).toEqual([]);
    expect(JSON.stringify(seen[1].messages[2].content[0])).toContain("do not fit get_frames");
  });
});

describe("the stand-in", () => {
  it("goes through the same guards: read, dry run, apply, answer", async () => {
    const ran: { name: string; args: Record<string, unknown> }[] = [];
    const out = await runNote({ ...base, brief: noteBrief({ title: "T", reelId: "r1", revision: 3, versions: [], history: [], note: "Make the titles bigger" }) }, { turn: fakeNoteTurn, gate: always, tools: stubTools(ran) });
    expect(ran.map((call) => [call.name, call.args.dryRun])).toEqual([["get_reel", undefined], ["apply_commands", true], ["apply_commands", false]]);
    expect(ran[1].args.commands).toEqual([{ type: "updateText", textId: "t1", patch: { size: 1.25 } }]);
    expect(out.changed).toBe(true);
  });

  it("changes nothing for a note it cannot read", async () => {
    const ran: { name: string; args: Record<string, unknown> }[] = [];
    const out = await runNote({ ...base, brief: noteBrief({ title: "T", reelId: "r1", revision: 3, versions: [], history: [], note: "hello" }) }, { turn: fakeNoteTurn, gate: always, tools: stubTools(ran) });
    expect(out.changed).toBe(false);
    expect(out.reply).toContain("could not tell");
  });
});

describe("the brief", () => {
  it("names the versions and the earlier notes", () => {
    const brief = noteBrief({ title: "Fit", reelId: "r1", revision: 7, versions: [{ label: "v1", exportId: "e1", status: "SUCCEEDED" }], history: [{ note: "titles bigger", reply: "Done." }], note: "show the desk earlier" });
    expect(brief).toContain("v1 = export e1 (SUCCEEDED)");
    expect(brief).toContain('- "titles bigger" -> Done.');
    expect(brief).toContain('"""\nshow the desk earlier\n"""');
    void z;
  });
});
