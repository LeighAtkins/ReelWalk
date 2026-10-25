/**
 * The admin step for ADR 0079: give an existing person a new workspace (name,
 * slug, AI on or off, optionally a bundled brand kit from ADR 0078). The
 * command-line wrapper is `apps/web/scripts/create-workspace.mts`; this file
 * holds the parts a test can run without a shell. It imports nothing from the
 * app (no "@/" paths) so `tsx` can load it from a script.
 */

export type CreateWorkspaceArgs = { email: string; name: string; slug: string; ai: "on" | "off"; brandKit: string | null; dryRun: boolean };

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export const USAGE = [
  "usage: create-workspace.mts --email <user email> --name <workspace name> [--slug <slug>] [--ai on|off] [--brand-kit <id>] [--dry-run]",
  "  --email       an existing account; it gets an OWNER seat in the new workspace (its home workspace is unchanged)",
  "  --slug        lowercase letters, digits and dashes (3-40); default: made from the name",
  "  --ai          on (default) or off: off refuses every AI generation path in the workspace",
  "  --brand-kit   a bundled brand kit id (ADR 0078, for example last-mile); refused if this build has no brand kits",
  "  --dry-run     say what would happen and change nothing",
].join("\n");

const slugFromName = (name: string) =>
  name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");

/** Parses `--flag value` arguments. Returns a message instead of throwing so the script can print usage. */
export function parseCreateWorkspaceArgs(argv: readonly string[]): { ok: true; args: CreateWorkspaceArgs } | { ok: false; message: string } {
  const values = new Map<string, string>();
  let dryRun = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (!flag.startsWith("--")) return { ok: false, message: `Unexpected argument: ${flag}` };
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, message: `${flag} needs a value.` };
    values.set(flag.slice(2), value);
    index++;
  }
  const known = new Set(["email", "name", "slug", "ai", "brand-kit"]);
  for (const key of values.keys()) if (!known.has(key)) return { ok: false, message: `Unknown option --${key}.` };
  const email = values.get("email")?.trim().toLowerCase();
  const name = values.get("name")?.trim().replace(/\s+/g, " ");
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) return { ok: false, message: "--email must be the address of an existing account." };
  if (!name || name.length > 60) return { ok: false, message: "--name is required (at most 60 characters)." };
  const slug = values.get("slug")?.trim().toLowerCase() ?? slugFromName(name);
  if (!SLUG_PATTERN.test(slug)) return { ok: false, message: `--slug must be 3-40 lowercase letters, digits and dashes (got "${slug}").` };
  const ai = values.get("ai") ?? "on";
  if (ai !== "on" && ai !== "off") return { ok: false, message: '--ai must be "on" or "off".' };
  return { ok: true, args: { email, name, slug, ai, brandKit: values.get("brand-kit")?.trim() || null, dryRun } };
}

/** The slice of the Prisma client this needs, so a test can hand in a stand-in. */
export type WorkspaceAdminDb = {
  user: { findUnique(args: { where: { email: string }; select: { id: true; email: true; workspaceId: true } }): Promise<{ id: string; email: string; workspaceId: string } | null> };
  workspace: {
    findUnique(args: { where: { slug: string }; select: { id: true; name: true; aiGeneration: true } }): Promise<{ id: string; name: string; aiGeneration: string } | null>;
    create(args: { data: { slug: string; name: string; aiGeneration: string; brandKit?: unknown } }): Promise<{ id: string }>;
    update(args: { where: { id: string }; data: { aiGeneration?: string; brandKit?: unknown } }): Promise<unknown>;
  };
  workspaceMember: {
    findUnique(args: { where: { userId_workspaceId: { userId: string; workspaceId: string } } }): Promise<{ id: string } | null>;
    create(args: { data: { userId: string; workspaceId: string; role: "OWNER" } }): Promise<unknown>;
  };
  $transaction<T>(work: (tx: WorkspaceAdminDb) => Promise<T>): Promise<T>;
};

export type BrandKitSupport = { available: boolean; kits: Readonly<Record<string, unknown>> };

export type CreateWorkspaceOutcome =
  | { ok: true; created: boolean; workspaceId: string; summary: string[] }
  | { ok: false; message: string };

/**
 * Creates the workspace and the OWNER seat, or finishes the job if it half-exists. Safe to run again with
 * the same arguments: an existing workspace with this slug that the person already owns gets only the AI
 * switch and brand kit set. A slug that belongs to someone else's workspace is refused.
 */
export async function createWorkspaceForEmail(db: WorkspaceAdminDb, args: CreateWorkspaceArgs, brandKits: BrandKitSupport): Promise<CreateWorkspaceOutcome> {
  let kit: unknown;
  if (args.brandKit) {
    if (!brandKits.available) return { ok: false, message: "This build has no brand kits (ADR 0078 is not in it), so --brand-kit cannot be used. Create the workspace without it and assign the kit later with apps/web/scripts/brand-kit.mts." };
    kit = brandKits.kits[args.brandKit];
    if (!kit) return { ok: false, message: `No bundled brand kit called "${args.brandKit}". Available: ${Object.keys(brandKits.kits).join(", ") || "none"}.` };
  }
  const user = await db.user.findUnique({ where: { email: args.email }, select: { id: true, email: true, workspaceId: true } });
  if (!user) return { ok: false, message: `No account with the email ${args.email}. The person signs up first; this adds a workspace to an existing account.` };
  const existing = await db.workspace.findUnique({ where: { slug: args.slug }, select: { id: true, name: true, aiGeneration: true } });
  const summary = [`account: ${user.email}`, `workspace: ${args.name} (${args.slug})`, `AI generation: ${args.ai}`, `brand kit: ${args.brandKit ?? "none"}`];

  if (existing) {
    const seat = await db.workspaceMember.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: existing.id } } });
    if (!seat && existing.id !== user.workspaceId) return { ok: false, message: `The slug "${args.slug}" belongs to a workspace ${args.email} has no seat in. Pick another slug.` };
    if (args.dryRun) return { ok: true, created: false, workspaceId: existing.id, summary: [...summary, "already exists: would update the AI switch and brand kit only (dry run)"] };
    await db.workspace.update({ where: { id: existing.id }, data: { aiGeneration: args.ai, ...(kit ? { brandKit: kit } : {}) } });
    return { ok: true, created: false, workspaceId: existing.id, summary: [...summary, "already exists: AI switch and brand kit set, nothing else changed"] };
  }

  if (args.dryRun) return { ok: true, created: true, workspaceId: "(dry run)", summary: [...summary, "would create the workspace and an OWNER seat (dry run)"] };
  const workspaceId = await db.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({ data: { slug: args.slug, name: args.name, aiGeneration: args.ai, ...(kit ? { brandKit: kit } : {}) } });
    await tx.workspaceMember.create({ data: { userId: user.id, workspaceId: workspace.id, role: "OWNER" } });
    return workspace.id;
  });
  return { ok: true, created: true, workspaceId, summary: [...summary, `created ${workspaceId} with an OWNER seat`] };
}
