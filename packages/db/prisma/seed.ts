import { DEFAULT_USER_EMAIL, DEFAULT_WORKSPACE_SLUG, prisma } from "../src/index";

// Idempotent: safe to run on every deploy.
async function main() {
  const workspace = await prisma.workspace.upsert({
    where: { slug: DEFAULT_WORKSPACE_SLUG },
    update: {},
    create: { slug: DEFAULT_WORKSPACE_SLUG, name: "Demo Realty" },
  });

  await prisma.user.upsert({
    where: { email: DEFAULT_USER_EMAIL },
    update: {},
    create: { email: DEFAULT_USER_EMAIL, name: "Demo Agent", workspaceId: workspace.id },
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
