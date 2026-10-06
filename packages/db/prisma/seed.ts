import { DEFAULT_USER_EMAIL, DEFAULT_WORKSPACE_SLUG, hashPassword, prisma } from "../src/index";

// Idempotent: safe to run on every deploy.
async function main() {
  const workspace = await prisma.workspace.upsert({
    where: { slug: DEFAULT_WORKSPACE_SLUG },
    update: {},
    create: { slug: DEFAULT_WORKSPACE_SLUG, name: "Demo Realty" },
  });

  // The demo studio can be signed into when DEMO_PASSWORD is set (local
  // Compose sets one; a public deployment leaves it unset).
  const passwordHash = process.env.DEMO_PASSWORD ? await hashPassword(process.env.DEMO_PASSWORD) : undefined;
  await prisma.user.upsert({
    where: { email: DEFAULT_USER_EMAIL },
    update: passwordHash ? { passwordHash } : {},
    create: { email: DEFAULT_USER_EMAIL, name: "Demo Agent", workspaceId: workspace.id, passwordHash },
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
