import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src";

const MIGRATION = new URL("../prisma/migrations/20261021030000_reel_variants/migration.sql", import.meta.url);

describe("variant sets migration (ADR 0063)", () => {
  it("is additive: it only creates tables, indexes and foreign keys to them", () => {
    const sql = readFileSync(MIGRATION, "utf8").replace(/--.*$/gm, "");
    const statements = sql.split(";").map((statement) => statement.trim()).filter(Boolean);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      const additive = /^CREATE TABLE "(VariantGroup|ReelVariant)"/.test(statement)
        || /^CREATE INDEX "(VariantGroup|ReelVariant)_/.test(statement)
        || /^ALTER TABLE "(VariantGroup|ReelVariant)" ADD CONSTRAINT/.test(statement);
      expect(additive, statement).toBe(true);
    }
    expect(sql).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER COLUMN/i);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("variant sets (Postgres)", () => {
  const workspaceIds: string[] = [];
  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.$disconnect();
  });

  it("groups sibling reels, keeps the set when the source reel goes, and goes with the workspace", async () => {
    const workspace = await prisma.workspace.create({ data: { slug: `variants-${randomUUID()}`, name: "Variants test" } });
    workspaceIds.push(workspace.id);
    const timeline = { version: 1, clips: [], texts: [], music: null };
    const source = await prisma.reel.create({ data: { workspaceId: workspace.id, title: "Source", timeline } });
    const group = await prisma.variantGroup.create({
      data: {
        workspaceId: workspace.id,
        sourceReelId: source.id,
        variants: {
          create: [
            { hook: "hero", lengthS: 15, reel: { create: { workspaceId: workspace.id, title: "Hero 15", timeline } } },
            { hook: "title", lengthS: 30, reel: { create: { workspaceId: workspace.id, title: "Title 30", timeline } } },
          ],
        },
      },
      include: { variants: true },
    });
    expect(group.variants.map((variant) => variant.hook).sort()).toEqual(["hero", "title"]);

    await prisma.reelVariant.update({ where: { reelId: group.variants[0].reelId }, data: { views: 1200, reach: 900, insightsAt: new Date() } });
    await prisma.reel.delete({ where: { id: source.id } });
    const kept = await prisma.variantGroup.findUniqueOrThrow({ where: { id: group.id }, include: { variants: true } });
    expect(kept.sourceReelId).toBeNull();
    expect(kept.variants.find((variant) => variant.views === 1200)).toBeTruthy();

    // Deleting a variant reel takes its place in the set with it.
    await prisma.reel.delete({ where: { id: group.variants[1].reelId } });
    expect(await prisma.reelVariant.count({ where: { groupId: group.id } })).toBe(1);
  });
});
