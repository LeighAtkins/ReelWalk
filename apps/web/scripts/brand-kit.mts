/**
 * Admin script for workspace brand kits (ADR 0078). A kit is data on `Workspace.brandKit`; nothing in the app assigns one,
 * so no workspace sees a kit until this is run for it, and assigning one to a workspace does not touch any other.
 *
 *   DATABASE_URL=... pnpm -C apps/web tsx scripts/brand-kit.mts list
 *   DATABASE_URL=... pnpm -C apps/web tsx scripts/brand-kit.mts assign <workspace slug | user email> <bundled kit id | path to kit.json> [--dry]
 *   DATABASE_URL=... pnpm -C apps/web tsx scripts/brand-kit.mts show   <workspace slug | user email>
 *   DATABASE_URL=... pnpm -C apps/web tsx scripts/brand-kit.mts remove <workspace slug | user email>
 *
 * The kit is validated with the same schema the app reads it with before it is written; a kit that fails is not stored.
 * Needs migration 20261025020000_brand_kit applied (it adds the column).
 */
import { readFileSync } from "node:fs";
import { BUNDLED_BRAND_KITS, brandKitSchema, readBrandKit } from "@reelwalk/core";
import { Prisma, prisma } from "@reelwalk/db";

const [command, who, source, ...flags] = process.argv.slice(2);

function usage(): never {
  console.error("usage: brand-kit.mts list | assign <slug|email> <kit id|file.json> [--dry] | show <slug|email> | remove <slug|email>");
  process.exit(2);
}

async function findWorkspace(ref: string) {
  const byEmail = ref.includes("@") ? await prisma.user.findUnique({ where: { email: ref.toLowerCase() }, select: { workspace: { select: { id: true, slug: true, name: true } } } }) : null;
  return byEmail?.workspace ?? (await prisma.workspace.findUnique({ where: { slug: ref }, select: { id: true, slug: true, name: true } }));
}

if (command === "list") {
  for (const kit of Object.values(BUNDLED_BRAND_KITS)) console.log(`${kit.id}: ${kit.name}, ${kit.styles.length} styles (${kit.styles.map((style) => style.name).join(", ")})`);
  process.exit(0);
}
if (!who || !["assign", "show", "remove"].includes(command ?? "")) usage();

const workspace = await findWorkspace(who);
if (!workspace) {
  console.error(`no workspace or account matching ${who}`);
  process.exit(1);
}

if (command === "show") {
  const row = await prisma.workspace.findUnique({ where: { id: workspace.id }, select: { brandKit: true } });
  const kit = readBrandKit(row?.brandKit);
  console.log(kit ? `${workspace.name} (${workspace.slug}): ${kit.name}, styles ${kit.styles.map((style) => style.name).join(", ")}` : `${workspace.name} (${workspace.slug}): no brand kit`);
} else if (command === "remove") {
  await prisma.workspace.update({ where: { id: workspace.id }, data: { brandKit: Prisma.DbNull } });
  console.log(`${workspace.name} (${workspace.slug}): brand kit removed (reels already styled keep their look)`);
} else {
  if (!source) usage();
  const raw = BUNDLED_BRAND_KITS[source] ?? JSON.parse(readFileSync(source, "utf8"));
  const parsed = brandKitSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`that kit is not valid:\n${parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n")}`);
    process.exit(1);
  }
  if (flags.includes("--dry")) {
    console.log(`would give ${workspace.name} (${workspace.slug}) the ${parsed.data.name} kit: ${parsed.data.styles.length} styles, ${parsed.data.palette.length} colours`);
  } else {
    await prisma.workspace.update({ where: { id: workspace.id }, data: { brandKit: parsed.data } });
    console.log(`${workspace.name} (${workspace.slug}): ${parsed.data.name} kit assigned (${parsed.data.styles.length} styles, ${parsed.data.palette.length} colours)`);
  }
}
await prisma.$disconnect();
