import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { structuredAnswer } from "../../../apps/web/lib/openai";
import { withProviderGate } from "../../../apps/web/lib/provider-gate";

// ADR 0049: the durable worker learns about paid submissions from the gate
// around the provider fetch. These check where structuredAnswer calls it.
const options = { instructions: "i", input: "x", schemaName: "s", schema: { type: "object" } };

describe("provider gate around structuredAnswer", () => {
  const env = { ...process.env };
  beforeEach(() => { process.env.AI_PROVIDER = "anthropic"; process.env.ANTHROPIC_API_KEY = "test-key"; });
  afterEach(() => { process.env = { ...env }; vi.unstubAllGlobals(); });

  it("records the submission before the request and the answer once a response arrives", async () => {
    const order: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => { order.push("fetch"); return new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 }); }));
    const gate = { beforeRequest: vi.fn(async () => { order.push("before"); }), answered: vi.fn(() => { order.push("answered"); }) };
    await expect(withProviderGate(gate, () => structuredAnswer(options))).rejects.toThrow();
    // A refused request is still an answer: the outcome is definite.
    expect(order).toEqual(["before", "fetch", "answered"]);
  });

  it("leaves a request that never got a response unanswered", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    const gate = { beforeRequest: vi.fn(async () => {}), answered: vi.fn() };
    await expect(withProviderGate(gate, () => structuredAnswer(options))).rejects.toThrow("Could not reach Claude.");
    expect(gate.beforeRequest).toHaveBeenCalledTimes(1);
    expect(gate.answered).not.toHaveBeenCalled();
  });

  it("sends nothing when the gate refuses", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const gate = { beforeRequest: vi.fn(async () => { throw new Error("stopped"); }), answered: vi.fn() };
    await expect(withProviderGate(gate, () => structuredAnswer(options))).rejects.toThrow("stopped");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is a no-op outside a gate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await expect(structuredAnswer(options)).rejects.toThrow("Could not reach Claude.");
  });
});
