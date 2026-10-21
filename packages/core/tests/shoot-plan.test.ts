import { beforeEach, describe, expect, it, vi } from "vitest";
import { shootRequestSchema, standardShotList, type ShotList } from "../src";

// "Plan my shoot" on the server (ADR 0063): the model's strict-JSON answer is
// validated, recorded as one AI request, and replaced by the standard list
// whenever the model cannot be used.
const state = vi.hoisted(() => ({
  answer: null as null | (() => Promise<unknown>),
  blocked: null as null | { message: string; upgrade: boolean },
  fake: false,
  records: [] as unknown[],
  calls: [] as { schemaName: string; schema: unknown; input: string }[],
}));

vi.mock("@reelwalk/db", () => ({ prisma: { aiEdit: { create: async (args: unknown) => { state.records.push(args); return { id: "edit" }; } } } }));
vi.mock("@/lib/ai-edit", () => ({ aiEditBlockedReason: async () => state.blocked }));
vi.mock("@/lib/openai", () => {
  class AiError extends Error {
    constructor(message: string, public readonly transient: boolean) { super(message); }
  }
  return {
    AiError,
    aiModel: () => "test-model",
    isFakeAi: () => state.fake,
    usageCostUsd: () => 0,
    structuredAnswer: async (options: { schemaName: string; schema: unknown; input: string }) => {
      state.calls.push(options);
      return { json: await state.answer!(), model: "test-model", usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 20 } };
    },
  };
});

const shootModule = "@/lib/shoot";
const { planShoot } = (await import(shootModule)) as { planShoot: (user: { id: string; workspaceId: string }, request: unknown) => Promise<ShotList & { source: "ai" | "standard"; why?: string }> };
const { AiError } = (await import("@/lib/openai" as string)) as { AiError: new (message: string, transient: boolean) => Error };

const user = { id: "u", workspaceId: "w" };
const request = shootRequestSchema.parse({ propertyType: "villa", rooms: ["kitchen", "pool"] });
const shot = (room: string) => ({ room, title: room, how: `Film the ${room} slowly.`, move: "pan-left", holdS: 3 });

describe("planShoot", () => {
  beforeEach(() => {
    state.answer = null;
    state.blocked = null;
    state.fake = false;
    state.records = [];
    state.calls = [];
  });

  it("asks for the strict shot_list schema and returns the model's list, recorded as one request", async () => {
    state.answer = async () => ({ note: "Shoot the pool at golden hour.", shots: [shot("exterior"), shot("kitchen"), shot("pool")] });
    const list = await planShoot(user, request);
    expect(list.source).toBe("ai");
    expect(list.shots.map((s) => s.room)).toEqual(["exterior", "kitchen", "pool"]);
    expect(state.calls[0].schemaName).toBe("shot_list");
    expect(state.calls[0].input).toContain("kitchen, pool");
    expect(state.records).toHaveLength(1);
  });

  it("an answer that does not fit the schema gives the standard list, and is still recorded", async () => {
    state.answer = async () => ({ note: "", shots: [{ room: "kitchen" }] });
    const list = await planShoot(user, request);
    expect(list.source).toBe("standard");
    expect(list.shots).toEqual(standardShotList(request).shots);
    expect(list.why).toMatch(/did not make sense/);
    expect(state.records).toHaveLength(1);
  });

  it("a model that does not answer gives the standard list", async () => {
    state.answer = async () => { throw new AiError("down", false); };
    const list = await planShoot(user, request);
    expect(list.source).toBe("standard");
    expect(list.why).toMatch(/did not answer/);
    expect(state.records).toHaveLength(0);
  });

  it("no request is made when the allowance is used up or the model is the stand-in", async () => {
    state.blocked = { message: "That is all 5 of this month's free requests.", upgrade: true };
    expect((await planShoot(user, request)).why).toMatch(/free requests\. Here is the standard list/);
    state.blocked = null;
    state.fake = true;
    expect((await planShoot(user, request)).source).toBe("standard");
    expect(state.calls).toHaveLength(0);
  });
});
