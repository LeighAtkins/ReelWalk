import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyTimeline } from "../src";

// ADR 0049 review item 1: the real askForChange, run inside the worker's
// provider gate, must not send a second paid request after one got no answer.
vi.mock("@reelwalk/db", () => ({ prisma: {
  aiEdit: { count: async () => 0, create: async () => ({ id: "edit" }) },
  mediaAsset: { findMany: async () => [], count: async () => 0 },
} }));
vi.mock("@/lib/plans", () => ({ workspacePlan: async () => ({ id: "AGENT", plan: { aiEditsPerMonth: 99 } }) }));
vi.mock("@/lib/quotas", () => ({ isUnlimited: async () => true }));
vi.mock("@/lib/room-labels", () => ({ labelRooms: async () => ({}) }));
vi.mock("@/lib/instagram-songs", () => ({ instagramSongs: async () => [] }));
vi.mock("@/lib/pano-aim", () => ({ aimPano: async () => null }));
vi.mock("@/lib/library", () => ({ toLibraryAssets: async () => [] }));

// Web modules are compiled by the web workspace; load them under Vitest's web aliases here.
const askModule = "@/lib/ai-edit";
const { askForChange } = (await import(askModule)) as { askForChange: (input: unknown) => Promise<{ ok: boolean }> };
const { withProviderGate } = await import("../../../apps/web/lib/provider-gate");

const input = { user: { id: "u", workspaceId: "w" }, reel: { id: "r", title: "Villa" }, timeline: emptyTimeline(), request: "Make it calmer" };

describe("askForChange inside the provider gate", () => {
  const env = { ...process.env };
  beforeEach(() => { process.env.AI_PROVIDER = "anthropic"; process.env.ANTHROPIC_API_KEY = "test-key"; delete process.env.DEV_FAKE_AI; });
  afterEach(() => { process.env = { ...env }; vi.unstubAllGlobals(); });

  it("does not resend a request that got no answer", async () => {
    // The request leaves, then the connection drops: sent, never answered.
    const fetch = vi.fn(async () => { throw new Error("socket hang up"); });
    vi.stubGlobal("fetch", fetch);
    const gate = { beforeRequest: vi.fn(async () => {}), answered: vi.fn() };
    const result = await withProviderGate(gate, () => askForChange(input));
    expect(result.ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(gate.beforeRequest).toHaveBeenCalledTimes(1);
    expect(gate.answered).not.toHaveBeenCalled();
  });

  it("keeps its one retry on the in-process path", async () => {
    const fetch = vi.fn(async () => { throw new Error("socket hang up"); });
    vi.stubGlobal("fetch", fetch);
    expect((await askForChange(input)).ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("sends nothing once the attempt was given up", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const abort = new AbortController();
    abort.abort(new Error("deadline"));
    const gate = { beforeRequest: vi.fn(async () => {}), answered: vi.fn(), signal: abort.signal };
    await expect(withProviderGate(gate, () => askForChange(input))).rejects.toThrow("deadline");
    expect(fetch).not.toHaveBeenCalled();
    expect(gate.beforeRequest).not.toHaveBeenCalled();
  });
});
