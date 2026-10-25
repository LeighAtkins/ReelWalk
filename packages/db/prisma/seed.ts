import { DEFAULT_USER_EMAIL, DEFAULT_WORKSPACE_SLUG, hashPassword, prisma } from "../src/index";

// Idempotent: safe to run on every deploy.
async function main() {
  // On a local stack (DEMO_PASSWORD set) the demo studio is comped onto the
  // Studio plan: the end-to-end suite exports more reels than the free plan's
  // monthly allowance. A public deployment leaves it on Free.
  const comped = process.env.DEMO_PASSWORD ? { compedPlan: "OFFICE" as const, compedUntil: new Date("2099-01-01T00:00:00Z") } : {};
  const workspace = await prisma.workspace.upsert({
    where: { slug: DEFAULT_WORKSPACE_SLUG },
    update: comped,
    create: { slug: DEFAULT_WORKSPACE_SLUG, name: "Demo Realty", ...comped },
  });

  // The demo studio can be signed into when DEMO_PASSWORD is set (local
  // Compose sets one; a public deployment leaves it unset).
  const passwordHash = process.env.DEMO_PASSWORD ? await hashPassword(process.env.DEMO_PASSWORD) : undefined;
  // On a local stack the demo user is also the admin, so the suite can check /admin/featured.
  const isAdmin = Boolean(passwordHash);
  const demo = await prisma.user.upsert({
    where: { email: DEFAULT_USER_EMAIL },
    update: { ...(passwordHash ? { passwordHash } : {}), isAdmin },
    create: { email: DEFAULT_USER_EMAIL, name: "Demo Agent", workspaceId: workspace.id, passwordHash, isAdmin },
  });
  // Every user owns their home workspace (ADR 0079).
  await prisma.workspaceMember.upsert({
    where: { userId_workspaceId: { userId: demo.id, workspaceId: demo.workspaceId } },
    update: {},
    create: { userId: demo.id, workspaceId: demo.workspaceId, role: "OWNER" },
  });

  const templates = [
    {
      slug: "walkthrough",
      name: "Walkthrough",
      description: "Full-height footage with a floorplan marker and a caption bar.",
      compositionId: "StubReel",
      defaultCaption: "Walk through this listing in seconds",
      brand: "ReelWalk",
    },
    {
      slug: "open-house",
      name: "Open house",
      description: "Same layout with open-house wording for event promotion.",
      compositionId: "StubReel",
      defaultCaption: "Open house this weekend",
      brand: "ReelWalk Open House",
    },
  ];
  for (const template of templates) {
    await prisma.template.upsert({ where: { slug: template.slug }, update: template, create: template });
  }

  console.log(`Seeded workspace "${workspace.slug}" and ${templates.length} templates`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
