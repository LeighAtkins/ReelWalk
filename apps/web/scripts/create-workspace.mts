/**
 * Admin step for ADR 0079: give an existing account a new workspace.
 *
 *   DATABASE_URL=... pnpm -C apps/web tsx scripts/create-workspace.mts \
 *     --email leigh.atkins1@gmail.com --name "Last Mile" --slug last-mile --ai off --brand-kit last-mile
 *
 * Add --dry-run to see what would happen. Safe to run twice with the same
 * arguments (it only sets the AI switch and brand kit the second time). It
 * does not touch the person's home workspace, sessions or other data.
 * --brand-kit needs ADR 0078 (brand kits) in the build; without it the script
 * refuses before changing anything.
 */
import * as core from "@reelwalk/core";
import { Prisma, prisma } from "@reelwalk/db";
import { USAGE, createWorkspaceForEmail, parseCreateWorkspaceArgs, type BrandKitSupport, type WorkspaceAdminDb } from "../lib/admin-workspace";

const parsed = parseCreateWorkspaceArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`${parsed.message}\n\n${USAGE}`);
  process.exit(2);
}

// ADR 0078 adds Workspace.brandKit and BUNDLED_BRAND_KITS. This build may not have them yet.
const column = Object.hasOwn(Prisma.WorkspaceScalarFieldEnum, "brandKit");
const kits = (core as unknown as { BUNDLED_BRAND_KITS?: Record<string, unknown> }).BUNDLED_BRAND_KITS;
const brandKits: BrandKitSupport = { available: column && Boolean(kits), kits: kits ?? {} };

const outcome = await createWorkspaceForEmail(prisma as unknown as WorkspaceAdminDb, parsed.args, brandKits);
if (!outcome.ok) {
  console.error(outcome.message);
  await prisma.$disconnect();
  process.exit(1);
}
console.log(outcome.summary.join("\n"));
await prisma.$disconnect();
