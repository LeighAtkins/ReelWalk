import { describe, expect, it } from "vitest";
import { createWorkspaceForEmail, parseCreateWorkspaceArgs, type BrandKitSupport, type CreateWorkspaceArgs, type WorkspaceAdminDb } from "./admin-workspace";

const KIT = { id: "last-mile", name: "Last Mile" };
const WITH_KITS: BrandKitSupport = { available: true, kits: { "last-mile": KIT } };
const NO_KITS: BrandKitSupport = { available: false, kits: {} };

/** A tiny in-memory stand-in for the slice of Prisma the admin step uses. */
function fakeDb(options: { users?: { id: string; email: string; workspaceId: string }[]; workspaces?: { id: string; slug: string; name: string; aiGeneration: string; brandKit?: unknown }[]; seats?: { userId: string; workspaceId: string }[] } = {}) {
  const users = options.users ?? [{ id: "u1", email: "leigh@example.com", workspaceId: "ws_home" }];
  const workspaces = options.workspaces ?? [{ id: "ws_home", slug: "reelwalking", name: "ReelWalk", aiGeneration: "on" }];
  const seats = options.seats ?? [{ userId: "u1", workspaceId: "ws_home" }];
  const db: WorkspaceAdminDb & { rows: { users: typeof users; workspaces: typeof workspaces; seats: typeof seats } } = {
    rows: { users, workspaces, seats },
    user: { findUnique: async ({ where }) => users.find((user) => user.email === where.email) ?? null },
    workspace: {
      findUnique: async ({ where }) => workspaces.find((workspace) => workspace.slug === where.slug) ?? null,
      create: async ({ data }) => {
        const row = { id: `ws_${workspaces.length + 1}`, ...data };
        workspaces.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }) => Object.assign(workspaces.find((workspace) => workspace.id === where.id)!, data),
    },
    workspaceMember: {
      findUnique: async ({ where }) => (seats.find((seat) => seat.userId === where.userId_workspaceId.userId && seat.workspaceId === where.userId_workspaceId.workspaceId) ? { id: "seat" } : null),
      create: async ({ data }) => void seats.push({ userId: data.userId, workspaceId: data.workspaceId }),
    },
    $transaction: async (work) => work(db),
  };
  return db;
}

const args = (over: Partial<CreateWorkspaceArgs> = {}): CreateWorkspaceArgs => ({ email: "leigh@example.com", name: "Last Mile", slug: "last-mile", ai: "off", brandKit: "last-mile", dryRun: false, ...over });

describe("the admin script's arguments", () => {
  it("reads the documented command", () => {
    const parsed = parseCreateWorkspaceArgs(["--email", "Leigh.Atkins1@gmail.com", "--name", "Last Mile", "--slug", "last-mile", "--ai", "off", "--brand-kit", "last-mile"]);
    expect(parsed).toEqual({ ok: true, args: { email: "leigh.atkins1@gmail.com", name: "Last Mile", slug: "last-mile", ai: "off", brandKit: "last-mile", dryRun: false } });
  });

  it("makes the slug from the name and defaults AI to on", () => {
    expect(parseCreateWorkspaceArgs(["--email", "a@b.co", "--name", "Last   Mile!", "--dry-run"])).toEqual({ ok: true, args: { email: "a@b.co", name: "Last Mile!", slug: "last-mile", ai: "on", brandKit: null, dryRun: true } });
  });

  it("refuses what it cannot understand, with a message", () => {
    const bad = [
      [[], /--email/],
      [["--email", "nope", "--name", "x"], /--email/],
      [["--email", "a@b.co"], /--name/],
      [["--email", "a@b.co", "--name", "x".repeat(61)], /--name/],
      [["--email", "a@b.co", "--name", "Name", "--slug", "A B"], /--slug/],
      [["--email", "a@b.co", "--name", "Name", "--ai", "maybe"], /--ai/],
      [["--email", "a@b.co", "--name", "Name", "--frobnicate", "1"], /Unknown option/],
      [["--email", "a@b.co", "--name"], /needs a value/],
      [["stray"], /Unexpected argument/],
    ] as const;
    for (const [argv, message] of bad) {
      const parsed = parseCreateWorkspaceArgs(argv);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? "" : parsed.message).toMatch(message);
    }
  });
});

describe("creating a workspace for an existing account", () => {
  it("creates the workspace with AI off and the brand kit, and an OWNER seat, leaving the home workspace alone", async () => {
    const db = fakeDb();
    const outcome = await createWorkspaceForEmail(db, args(), WITH_KITS);
    expect(outcome).toMatchObject({ ok: true, created: true });
    expect(db.rows.workspaces.at(-1)).toMatchObject({ slug: "last-mile", name: "Last Mile", aiGeneration: "off", brandKit: KIT });
    expect(db.rows.seats).toContainEqual({ userId: "u1", workspaceId: db.rows.workspaces.at(-1)!.id });
    expect(db.rows.users[0].workspaceId).toBe("ws_home");
  });

  it("is safe to run twice: the second run only sets the switch and kit", async () => {
    const db = fakeDb();
    await createWorkspaceForEmail(db, args(), WITH_KITS);
    const again = await createWorkspaceForEmail(db, args({ ai: "on" }), WITH_KITS);
    expect(again).toMatchObject({ ok: true, created: false });
    expect(db.rows.workspaces).toHaveLength(2);
    expect(db.rows.workspaces.at(-1)!.aiGeneration).toBe("on");
    expect(db.rows.seats.filter((seat) => seat.userId === "u1")).toHaveLength(2);
  });

  it("changes nothing on a dry run", async () => {
    const db = fakeDb();
    const outcome = await createWorkspaceForEmail(db, args({ dryRun: true }), WITH_KITS);
    expect(outcome).toMatchObject({ ok: true, created: true, workspaceId: "(dry run)" });
    expect(db.rows.workspaces).toHaveLength(1);
    expect(db.rows.seats).toHaveLength(1);
  });

  it("refuses an unknown account", async () => {
    const outcome = await createWorkspaceForEmail(fakeDb(), args({ email: "nobody@example.com" }), WITH_KITS);
    expect(outcome).toMatchObject({ ok: false, message: expect.stringMatching(/No account with the email/) });
  });

  it("refuses a slug that belongs to a workspace the person has no seat in", async () => {
    const db = fakeDb({ workspaces: [{ id: "ws_home", slug: "reelwalking", name: "R", aiGeneration: "on" }, { id: "ws_x", slug: "last-mile", name: "Someone else's", aiGeneration: "on" }] });
    const outcome = await createWorkspaceForEmail(db, args(), WITH_KITS);
    expect(outcome).toMatchObject({ ok: false, message: expect.stringMatching(/no seat in/) });
    expect(db.rows.workspaces.find((workspace) => workspace.id === "ws_x")!.aiGeneration).toBe("on");
  });

  it("refuses --brand-kit before changing anything when this build has no brand kits, or the kit is unknown", async () => {
    const db = fakeDb();
    expect(await createWorkspaceForEmail(db, args(), NO_KITS)).toMatchObject({ ok: false, message: expect.stringMatching(/no brand kits/) });
    expect(await createWorkspaceForEmail(db, args({ brandKit: "nope" }), WITH_KITS)).toMatchObject({ ok: false, message: expect.stringMatching(/No bundled brand kit called "nope"/) });
    expect(db.rows.workspaces).toHaveLength(1);
  });

  it("works without a brand kit even when this build has none", async () => {
    const db = fakeDb();
    expect(await createWorkspaceForEmail(db, args({ brandKit: null }), NO_KITS)).toMatchObject({ ok: true, created: true });
    expect(db.rows.workspaces.at(-1)).not.toHaveProperty("brandKit");
  });
});
