/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The per-workspace AI switch (ADR 0079): with `aiGeneration` "off" every AI path refuses on the server, before any
 * provider request or credit reservation. One test per door a provider can be reached through, plus the routes.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  workspace: { findUnique: vi.fn<(...args: any[]) => any>() },
  reserve: vi.fn<(...args: any[]) => any>(),
  structured: vi.fn<(...args: any[]) => any>(),
}));

vi.mock("@reelwalk/db", () => ({
  prisma: { workspace: m.workspace, reel: { findFirst: vi.fn() }, mediaAsset: { findFirst: vi.fn() }, aiGeneration: { findFirst: vi.fn() } },
  reserveAiGeneration: m.reserve,
  aiCreditSummary: vi.fn(),
}));
vi.mock("./workspace", () => ({ mediaScope: () => ({}) }));
vi.mock("./quotas", () => ({ storageBlockedReason: async () => null, isUnlimited: async () => false }));
vi.mock("./google-federation", () => ({ federatedGoogleAuth: () => ({}), defaultGoogleAuth: async () => ({}) }));
vi.mock("./storage", () => ({ awsCredentials: () => async () => ({}) }));

import { AI_OFF_CODE, AI_OFF_MESSAGE, AiOffError, aiIsOff, aiOffResponse, aiSwitchOf, assertAiOn } from "./ai-gate";
import { structuredAnswer } from "./openai";
import { createAiGeneration } from "./ai-video";

const on = () => m.workspace.findUnique.mockResolvedValue({ aiGeneration: "on" });
const off = () => m.workspace.findUnique.mockResolvedValue({ aiGeneration: "off" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the switch", () => {
  it("is on unless the workspace says off", () => {
    expect(aiSwitchOf("on")).toBe("on");
    expect(aiSwitchOf("off")).toBe("off");
    expect(aiSwitchOf(undefined)).toBe("on");
    expect(aiSwitchOf("anything else")).toBe("on");
  });

  it("reads the workspace row, and treats a workspace that cannot be found as off", async () => {
    on();
    expect(await aiIsOff("ws1")).toBe(false);
    off();
    expect(await aiIsOff("ws1")).toBe(true);
    m.workspace.findUnique.mockResolvedValue(null);
    expect(await aiIsOff("ghost")).toBe(true);
    expect(m.workspace.findUnique).toHaveBeenLastCalledWith({ where: { id: "ghost" }, select: { aiGeneration: true } });
  });

  it("assertAiOn throws a clear AiOffError only when off", async () => {
    on();
    await expect(assertAiOn("ws1")).resolves.toBeUndefined();
    off();
    await expect(assertAiOn("ws1")).rejects.toMatchObject({ name: "AiOffError", code: AI_OFF_CODE, message: AI_OFF_MESSAGE });
    await expect(assertAiOn("ws1")).rejects.toBeInstanceOf(AiOffError);
  });

  it("aiOffResponse is null when on and a 403 with the message and code when off", async () => {
    on();
    expect(await aiOffResponse("ws1")).toBeNull();
    off();
    const response = (await aiOffResponse("ws1"))!;
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: AI_OFF_MESSAGE, message: AI_OFF_MESSAGE, code: "ai_off" });
  });
});

describe("every model call (structuredAnswer)", () => {
  const request = { instructions: "Edit.", input: "Do it.", schemaName: "x", schema: {} };

  it("never reaches a provider for a workspace with AI off", async () => {
    vi.stubEnv("AI_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    off();
    await expect(structuredAnswer({ ...request, workspaceId: "ws1" })).rejects.toMatchObject({ code: "ai_off" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still goes to the provider when AI is on", async () => {
    vi.stubEnv("AI_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    on();
    await expect(structuredAnswer({ ...request, workspaceId: "ws1" })).resolves.toMatchObject({ json: {} });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("AI video (createAiGeneration)", () => {
  const input = { requestId: "6f1d8a4e-3b1c-4b43-9a53-0d7b6b2c1e11", prompt: "Slow push in on an infinity pool at dusk" };
  const user = { id: "u1", workspaceId: "ws1", email: "a@example.com" };

  it("refuses before reserving any credit in a workspace with AI off", async () => {
    vi.stubEnv("AI_VIDEO_ENABLED", "true");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "p");
    off();
    await expect(createAiGeneration(user, input)).rejects.toThrow(AI_OFF_MESSAGE);
    await expect(createAiGeneration(user, { ...input, finalOf: "draft1" })).rejects.toThrow(AI_OFF_MESSAGE);
    await expect(createAiGeneration(user, { ...input, quality: "draft" })).rejects.toThrow(AI_OFF_MESSAGE);
    expect(m.reserve).not.toHaveBeenCalled();
  });
});

describe("the routes that start AI work", () => {
  // Each of these answers 403 ai_off before doing anything else (checked here by reading the handler's source: the
  // route modules pull in the whole server, and the behaviour of aiOffResponse itself is tested above).
  const routes = [
    "../app/api/ai/generations/route.ts",
    "../app/api/ai/performance/route.ts",
    "../app/api/ai/surface-regions/route.ts",
    "../app/api/reels/[id]/ai-edit/route.ts",
    "../app/api/reels/[id]/autopilot/route.ts",
    "../app/api/reels/[id]/director/route.ts",
    "../app/api/reels/[id]/director/generate/route.ts",
    "../app/api/reels/[id]/director/runs/[runId]/route.ts",
    "../app/api/reels/[id]/ideas/route.ts",
    "../app/api/reels/[id]/rooms/route.ts",
    "../app/api/reels/[id]/script/route.ts",
  ];

  for (const path of routes) {
    it(`${path.replace("../app/api/", "").replace("/route.ts", "")} checks the switch in its POST handler, after sign-in and before any work`, () => {
      const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
      const post = source.slice(source.indexOf("export async function POST"));
      const guard = post.indexOf("aiOffResponse(");
      expect(guard).toBeGreaterThan(-1);
      const signedIn = post.indexOf("getSessionUser()");
      expect(signedIn).toBeGreaterThan(-1);
      expect(guard).toBeGreaterThan(signedIn);
      // Nothing that reads the body, queries a reel or calls a model comes before the guard.
      // (The idea writer reads its body first, because its song list is the one kind that asks no model.)
      const before = post.slice(0, guard);
      expect(before).not.toMatch(path.includes("/ideas/") ? /structuredAnswer\(|createAiGeneration\(/ : /request\.json\(|prisma\.|structuredAnswer\(|createAiGeneration\(/);
    });
  }

  it("covers every route that imports an AI door: it is in the list above or exempt for a stated reason", () => {
    const root = fileURLToPath(new URL("../app/api", import.meta.url));
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.name === "route.ts") found.push(join(dir, entry.name));
      }
    };
    walk(root);
    const doors = /from "@\/lib\/(ai-edit|ai-director|ai-steps|autopilot|ai-video|openai|surface-vision|room-labels|pano-aim|shoot|stock-check)"/;
    // Routes that touch an AI module but ask no model and start no generation, or are gated one level down.
    const exempt: Record<string, string> = {
      "reels/[id]/finish/route.ts": "picks a song from the library; imports ai-edit only for its context()",
      "reels/[id]/commands/route.ts": "placeOnSurface's vision look is gated inside resolveSurfaceCommands (workspaceId) and structuredAnswer",
      "stock/search/route.ts": "checkStockClips returns 'unchecked' for a workspace with AI off, and structuredAnswer is gated",
    };
    const listed = new Set(routes.map((path) => path.replace("../app/api/", "")));
    for (const file of found) {
      const relative = file.slice(root.length + 1).split(sep).join("/");
      if (!doors.test(readFileSync(file, "utf8"))) continue;
      expect(listed.has(relative) || relative in exempt, `${relative} imports an AI module but is neither guarded nor exempt`).toBe(true);
    }
  });
});
