/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Workspaces against a real Postgres (ADR 0079): the signed cookie, the switch action, the seat check, and above
 * all isolation: after switching, nothing of another workspace (or of a stranger's) can be read or written by id
 * through the real routes, actions and connector tools. Skipped without DATABASE_URL (a migrated database, for
 * example a throwaway Postgres; see the ADR). The unit tests next to it cover the same rules without a database.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { emptyTimeline, addClips } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";

const jar = vi.hoisted(() => ({ cookies: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.cookies.has(name) ? { name, value: jar.cookies.get(name) } : undefined),
    set: (name: string, value: string) => void jar.cookies.set(name, value),
    delete: (name: string) => void jar.cookies.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const enabled = Boolean(process.env.DATABASE_URL);
const run = `t${randomBytes(4).toString("hex")}`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

type Ids = Record<string, string>;
const ids: Ids = {};
const SESSION_U = `session-u-${run}-${"x".repeat(24)}`;

/** Runs a server action or route that ends in redirect() and returns where it went. */
async function redirected(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error: any) {
    const digest = String(error?.digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2];
    throw error;
  }
  throw new Error("expected a redirect");
}

describe.skipIf(!enabled)("workspaces against a real database", () => {
  beforeAll(async () => {
    const workspace = async (key: string, name: string) => (ids[key] = (await prisma.workspace.create({ data: { slug: `${run}-${key}`, name } })).id);
    await workspace("A", "ReelWalk");
    await workspace("B", "Last Mile");
    await workspace("C", "Stranger Studio");
    const user = async (key: string, home: string) => (ids[key] = (await prisma.user.create({ data: { email: `${run}-${key}@example.com`, name: key, workspaceId: ids[home] } })).id);
    await user("U", "A");
    await user("V", "C");
    // The migration's backfill gives each user an OWNER seat in their home workspace; U also owns Last Mile.
    await prisma.workspaceMember.createMany({ data: [{ userId: ids.U, workspaceId: ids.A }, { userId: ids.U, workspaceId: ids.B }, { userId: ids.V, workspaceId: ids.C }] });
    await prisma.session.create({ data: { id: sha(SESSION_U), userId: ids.U, expiresAt: new Date(Date.now() + 86_400_000) } });

    for (const key of ["A", "B", "C"]) {
      const workspaceId = ids[key];
      ids[`reel${key}`] = (await prisma.reel.create({ data: { workspaceId, title: `Reel ${key}`, timeline: emptyTimeline() as any } })).id;
      ids[`media${key}`] = (await prisma.mediaAsset.create({ data: { workspaceId, kind: "IMAGE", objectKey: `${run}/${key}.jpg`, contentType: "image/jpeg", fileName: `${key}.jpg`, sizeBytes: 1000 } })).id;
      const job = await prisma.renderJob.create({ data: { workspaceId, reelId: ids[`reel${key}`], kind: "REEL", status: "SUCCEEDED", progress: 100 } });
      await prisma.renderOutput.create({ data: { jobId: job.id, objectKey: `${run}/${key}.mp4`, contentType: "video/mp4", sizeBytes: 1000 } });
      ids[`job${key}`] = job.id;
      ids[`post${key}`] = (await prisma.scheduledPost.create({ data: { workspaceId, renderJobId: job.id, caption: `Post ${key}`, publishAt: new Date(Date.now() + 86_400_000) } })).id;
      const grant = await prisma.aiCreditGrant.create({ data: { workspaceId, source: `${run}-${key}`, kind: "TEST", amount: 10, remaining: 10 } });
      ids[`grant${key}`] = grant.id;
      ids[`shot${key}`] = (await prisma.aiGeneration.create({ data: { workspaceId, createdById: ids.U, requestId: `${run}-${key}`, grantId: grant.id, prompt: `Shot ${key}`, model: "veo" } })).id;
    }
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { slug: { startsWith: run } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: run } } });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    jar.cookies.clear();
    jar.cookies.set("rw_session", SESSION_U);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const sessionUser = async () => (await import("./auth")).getSessionUser();

  describe("which workspace a request is in", () => {
    it("is the home workspace with no workspace cookie", async () => {
      expect(await sessionUser()).toMatchObject({ id: ids.U, workspaceId: ids.A, homeWorkspaceId: ids.A, role: "OWNER" });
      expect((await sessionUser())!.workspace.name).toBe("ReelWalk");
    });

    it("follows the switch action to Last Mile and back, and a new sign-in starts at home", async () => {
      const { switchWorkspace } = await import("@/app/workspace-actions");
      const form = (workspaceId: string) => {
        const data = new FormData();
        data.set("workspaceId", workspaceId);
        return data;
      };
      expect(await redirected(() => switchWorkspace(form(ids.B)))).toBe("/");
      expect(await sessionUser()).toMatchObject({ workspaceId: ids.B, homeWorkspaceId: ids.A });
      expect((await sessionUser())!.workspace.name).toBe("Last Mile");
      await redirected(() => switchWorkspace(form(ids.A)));
      expect((await sessionUser())!.workspaceId).toBe(ids.A);
      await redirected(() => switchWorkspace(form(ids.B)));
      const { createSession } = await import("./auth");
      await createSession(ids.U);
      expect(jar.cookies.has("rw_workspace")).toBe(false);
    });

    it("refuses to switch into a workspace the person has no seat in, and nothing changes", async () => {
      const { switchWorkspace } = await import("@/app/workspace-actions");
      const data = new FormData();
      data.set("workspaceId", ids.C);
      expect(await redirected(() => switchWorkspace(data))).toBe("/account?workspace=denied");
      expect(jar.cookies.has("rw_workspace")).toBe(false);
      expect((await sessionUser())!.workspaceId).toBe(ids.A);
    });

    it("falls back to home for a perfectly signed cookie naming a workspace the person has no seat in, and for one whose seat was removed", async () => {
      const { signActiveWorkspace } = await import("./workspace-access");
      jar.cookies.set("rw_workspace", signActiveWorkspace(SESSION_U, ids.U, ids.C));
      expect((await sessionUser())!.workspaceId).toBe(ids.A);
      jar.cookies.set("rw_workspace", signActiveWorkspace(SESSION_U, ids.U, ids.B));
      expect((await sessionUser())!.workspaceId).toBe(ids.B);
      const seat = await prisma.workspaceMember.findFirstOrThrow({ where: { userId: ids.U, workspaceId: ids.B } });
      await prisma.workspaceMember.delete({ where: { id: seat.id } });
      try {
        expect((await sessionUser())!.workspaceId).toBe(ids.A);
      } finally {
        await prisma.workspaceMember.create({ data: { userId: ids.U, workspaceId: ids.B } });
      }
    });

    it("ignores a cookie that was signed for another session, or with a made-up signature", async () => {
      const { signActiveWorkspace } = await import("./workspace-access");
      jar.cookies.set("rw_workspace", signActiveWorkspace("someone-elses-session-token", ids.U, ids.B));
      expect((await sessionUser())!.workspaceId).toBe(ids.A);
      jar.cookies.set("rw_workspace", `${ids.B}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
      expect((await sessionUser())!.workspaceId).toBe(ids.A);
    });

    it("creates a workspace the person owns and switches to it", async () => {
      const { createWorkspace } = await import("@/app/workspace-actions");
      const data = new FormData();
      data.set("name", "  Third   Studio ");
      expect(await redirected(() => createWorkspace(data))).toBe("/?welcome=1");
      const made = await prisma.workspace.findFirstOrThrow({ where: { name: "Third Studio", members: { some: { userId: ids.U } } } });
      expect(made.aiGeneration).toBe("on");
      expect(await prisma.workspaceMember.findFirst({ where: { userId: ids.U, workspaceId: made.id } })).toMatchObject({ role: "OWNER" });
      expect((await sessionUser())!.workspaceId).toBe(made.id);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.U } })).workspaceId).toBe(ids.A);
      await prisma.workspace.delete({ where: { id: made.id } });
    });
  });

  describe("isolation: nothing of another workspace is reachable by id", () => {
    const inWorkspace = async (key: "A" | "B") => {
      const { signActiveWorkspace } = await import("./workspace-access");
      if (key === "B") jar.cookies.set("rw_workspace", signActiveWorkspace(SESSION_U, ids.U, ids.B));
      else jar.cookies.delete("rw_workspace");
      expect((await sessionUser())!.workspaceId).toBe(ids[key]);
    };
    const params = (id: string) => ({ params: Promise.resolve({ id }) });

    for (const [here, other] of [["A", "B"], ["B", "A"]] as const) {
      describe(`signed in, acting in ${here === "A" ? "ReelWalk" : "Last Mile"}`, () => {
        beforeEach(() => inWorkspace(here));

        it("reels: loads its own, finds neither the other workspace's nor a stranger's", async () => {
          const { loadReel } = await import("./reel-command");
          const user = (await sessionUser())!;
          expect(await loadReel(user, ids[`reel${here}`])).toMatchObject({ id: ids[`reel${here}`] });
          expect(await loadReel(user, ids[`reel${other}`])).toBeNull();
          expect(await loadReel(user, ids.reelC)).toBeNull();
        });

        it("reels: cannot be saved over, by id, in another workspace", async () => {
          const { saveReelFor } = await import("./save-reel");
          const user = (await sessionUser())!;
          const before = await prisma.reel.findUniqueOrThrow({ where: { id: ids[`reel${other}`] } });
          for (const foreign of [ids[`reel${other}`], ids.reelC]) {
            expect(await saveReelFor(user, { id: foreign, revision: 0, timeline: emptyTimeline(), title: "Hijacked" })).toMatchObject({ ok: false, reason: "missing" });
          }
          expect(await prisma.reel.findUniqueOrThrow({ where: { id: ids[`reel${other}`] } })).toMatchObject({ title: before.title, revision: before.revision });
          expect(await saveReelFor(user, { id: ids[`reel${here}`], revision: 0, timeline: emptyTimeline(), title: `Reel ${here} edited` })).toMatchObject({ ok: true });
          await prisma.reel.update({ where: { id: ids[`reel${here}`] }, data: { title: `Reel ${here}`, revision: 0 } });
        });

        it("media: a reel here cannot use media of the other workspace or a stranger's", async () => {
          const { saveReelFor } = await import("./save-reel");
          const user = (await sessionUser())!;
          const { clipForAsset } = await import("./mcp/clips");
          const clip = (assetId: string) => addClips(emptyTimeline(), [clipForAsset({ id: assetId, kind: "IMAGE", durationMs: null, isPano: false, spot: null, room: null }, () => `c-${assetId}`)]);
          for (const foreign of [ids[`media${other}`], ids.mediaC]) {
            expect(await saveReelFor(user, { id: ids[`reel${here}`], revision: 0, timeline: clip(foreign) })).toMatchObject({ ok: false, reason: "invalid", message: expect.stringMatching(/another workspace/) });
          }
        });

        it("exports: another workspace's finished export reads as missing", async () => {
          const checks = await import("@/app/api/renders/[id]/checks/route");
          for (const foreign of [ids[`job${other}`], ids.jobC]) {
            const response = await checks.GET(new Request("https://reelwalking.com/api/renders/x/checks"), params(foreign));
            expect(response.status).toBe(404);
          }
        });

        it("scheduled posts: cancelling another workspace's post, by id, does nothing", async () => {
          const { cancelScheduled } = await import("@/app/scheduled-actions");
          const cancel = (id: string) => {
            const data = new FormData();
            data.set("id", id);
            return redirected(() => cancelScheduled(data));
          };
          expect(await cancel(ids[`post${other}`])).toBe("/scheduled?cancelled=late");
          expect(await cancel(ids.postC)).toBe("/scheduled?cancelled=late");
          expect((await prisma.scheduledPost.findUniqueOrThrow({ where: { id: ids[`post${other}`] } })).status).toBe("SCHEDULED");
          expect((await prisma.scheduledPost.findUniqueOrThrow({ where: { id: ids.postC } })).status).toBe("SCHEDULED");
          expect(await cancel(ids[`post${here}`])).toBe("/scheduled?cancelled=1");
          expect((await prisma.scheduledPost.findUniqueOrThrow({ where: { id: ids[`post${here}`] } })).status).toBe("CANCELLED");
          await prisma.scheduledPost.update({ where: { id: ids[`post${here}`] }, data: { status: "SCHEDULED" } });
        });

        it("AI generations: the list is this workspace's only", async () => {
          const generations = await import("@/app/api/ai/generations/route");
          const body = await (await generations.GET()).json();
          expect(body.jobs.map((job: any) => job.id)).toEqual([ids[`shot${here}`]]);
        });
      });
    }
  });

  describe("the connector acts in the workspace it was bound to", () => {
    const toolsFor = async (workspaceId: string) => {
      const { actingUserFor } = await import("./workspaces");
      const { TOOLS } = await import("./mcp/tools");
      const user = (await actingUserFor(ids.U, workspaceId))!;
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const spec = TOOLS.find((tool) => tool.name === name)!;
        const result = await spec.run({ user, scopes: ["reels:read", "reels:write", "exports", "ai:generate"], origin: "https://reelwalking.com" }, z.object(spec.input).parse(args));
        return JSON.parse((result.content[0] as any).text);
      };
      return { user, call };
    };

    it("a connection bound to Last Mile sees Last Mile's reels and no others", async () => {
      const { user, call } = await toolsFor(ids.B);
      expect(user).toMatchObject({ workspaceId: ids.B, homeWorkspaceId: ids.A });
      expect((await call("list_reels")).reels.map((reel: any) => reel.id)).toEqual([ids.reelB]);
      expect(await call("get_reel", { reelId: ids.reelB })).toMatchObject({ ok: true });
      for (const foreign of [ids.reelA, ids.reelC]) expect(await call("get_reel", { reelId: foreign })).toMatchObject({ ok: false });
      for (const foreign of [ids.jobA, ids.jobC]) expect(await call("get_export", { exportId: foreign })).toMatchObject({ ok: false });
      for (const foreign of [ids.shotA, ids.shotC]) expect(await call("get_ai_shot", { aiShotId: foreign })).toMatchObject({ ok: false });
      expect(await call("get_ai_shot", { aiShotId: ids.shotB })).toMatchObject({ ok: true });
    });

    it("list_workspaces names the bound workspace first and the other as a reconnect", async () => {
      const { call } = await toolsFor(ids.B);
      const listed = await call("list_workspaces");
      expect(listed.workspace).toMatchObject({ id: ids.B, name: "Last Mile", role: "owner", aiGeneration: "on" });
      expect(listed.others.map((workspace: any) => workspace.id)).toEqual([ids.A]);
      expect(listed.note).toMatch(/reconnect/);
    });

    it("a person cannot be bound to a workspace they have no seat in", async () => {
      const { actingUserFor } = await import("./workspaces");
      expect(await actingUserFor(ids.U, ids.C)).toBeNull();
      expect(await actingUserFor("no-such-user", ids.A)).toBeNull();
    });

    it("tokens carry the workspace of their grant, and lose it with the seat", async () => {
      const { registerClient, approve, exchangeCode, verifyAccessToken } = await import("./mcp/oauth-store");
      const { challengeFor } = await import("./mcp/oauth-core");
      const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
      const redirectUri = "https://claude.ai/api/mcp/auth_callback";
      const origin = "https://reelwalking.com";
      const client = await registerClient({ name: `Claude ${run}`, redirectUris: [redirectUri] });
      const code = await approve({ userId: ids.U, workspaceId: ids.B, clientId: client.id, scopes: ["reels:read", "ai:generate"], redirectUri, codeChallenge: challengeFor(verifier), origin });
      const issued: any = await exchangeCode({ code, clientId: client.id, redirectUri, codeVerifier: verifier });
      expect((await verifyAccessToken(issued.access_token, origin))?.user.workspaceId).toBe(ids.B);
      // AI turned off after the fact: the credit-spending scope goes with it.
      await prisma.workspace.update({ where: { id: ids.B }, data: { aiGeneration: "off" } });
      try {
        expect((await verifyAccessToken(issued.access_token, origin))?.scopes).toEqual(["reels:read"]);
      } finally {
        await prisma.workspace.update({ where: { id: ids.B }, data: { aiGeneration: "on" } });
      }
      const seat = await prisma.workspaceMember.findFirstOrThrow({ where: { userId: ids.U, workspaceId: ids.B } });
      await prisma.workspaceMember.delete({ where: { id: seat.id } });
      try {
        expect(await verifyAccessToken(issued.access_token, origin)).toBeNull();
      } finally {
        await prisma.workspaceMember.create({ data: { userId: ids.U, workspaceId: ids.B } });
      }
      await prisma.oAuthClient.delete({ where: { id: client.id } });
    });
  });

  describe("AI off", () => {
    beforeEach(async () => {
      await prisma.workspace.update({ where: { id: ids.B }, data: { aiGeneration: "off" } });
    });
    afterAll(async () => {
      await prisma.workspace.update({ where: { id: ids.B }, data: { aiGeneration: "on" } });
    });

    it("refuses AI video and spends no credit, while the same request in a workspace with AI on goes through", async () => {
      vi.stubEnv("AI_VIDEO_ENABLED", "true");
      vi.stubEnv("GOOGLE_CLOUD_PROJECT", "test-project");
      const { createAiGeneration } = await import("./ai-video");
      const input = { requestId: crypto.randomUUID(), prompt: "Slow push in on an infinity pool at dusk" };
      const credits = () => prisma.aiCreditGrant.findUniqueOrThrow({ where: { id: ids.grantB } }).then((grant) => grant.remaining);
      const shots = () => prisma.aiGeneration.count({ where: { workspaceId: ids.B } });
      const before = { credits: await credits(), shots: await shots() };
      await expect(createAiGeneration({ id: ids.U, workspaceId: ids.B, email: "x@example.com" }, input)).rejects.toThrow(/turned off for this workspace/);
      await expect(createAiGeneration({ id: ids.U, workspaceId: ids.B, email: "x@example.com" }, { ...input, quality: "draft" })).rejects.toThrow(/turned off/);
      expect({ credits: await credits(), shots: await shots() }).toEqual(before);
      // The same request in a workspace with AI on goes through (and reserves its credit there, not in Last Mile).
      await expect(createAiGeneration({ id: ids.U, workspaceId: ids.A, email: "x@example.com" }, { ...input, requestId: crypto.randomUUID() })).resolves.toMatchObject({ status: "QUEUED", workspaceId: ids.A });
    });

    it("refuses every model call and never contacts a provider", async () => {
      vi.stubEnv("AI_PROVIDER", "openai");
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const { structuredAnswer } = await import("./openai");
      await expect(structuredAnswer({ workspaceId: ids.B, instructions: "x", input: "y", schemaName: "s", schema: {} })).rejects.toMatchObject({ code: "ai_off" });
      const { aiEditBlockedReason } = await import("./ai-edit");
      expect(await aiEditBlockedReason(ids.B)).toMatchObject({ message: expect.stringMatching(/turned off/) });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("the connector's generate_ai_shot refuses without quoting", async () => {
      vi.stubEnv("AI_VIDEO_ENABLED", "true");
      vi.stubEnv("GOOGLE_CLOUD_PROJECT", "test-project");
      const { actingUserFor } = await import("./workspaces");
      const { TOOLS } = await import("./mcp/tools");
      const user = (await actingUserFor(ids.U, ids.B))!;
      const spec = TOOLS.find((tool) => tool.name === "generate_ai_shot")!;
      const result = await spec.run({ user, scopes: ["ai:generate"], origin: "https://reelwalking.com" }, z.object(spec.input).parse({ prompt: "Slow push in on an infinity pool at dusk", confirmCredits: 1 }));
      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content[0] as any).text)).toMatchObject({ code: "ai_off" });
    });

    it("the generations route answers 403 ai_off for a POST", async () => {
      jar.cookies.set("rw_workspace", (await import("./workspace-access")).signActiveWorkspace(SESSION_U, ids.U, ids.B));
      vi.stubEnv("APP_URL", "https://reelwalking.com");
      const generations = await import("@/app/api/ai/generations/route");
      const response = await generations.POST(new Request("https://reelwalking.com/api/ai/generations", { method: "POST", headers: { origin: "https://reelwalking.com", "content-type": "application/json" }, body: "{}" }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "ai_off" });
    });
  });
});
