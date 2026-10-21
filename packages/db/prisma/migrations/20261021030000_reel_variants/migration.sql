-- Variant sets (ADR 0063). Additive only: two new tables, nothing existing changes.
-- CreateTable
CREATE TABLE "VariantGroup" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceReelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VariantGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReelVariant" (
    "reelId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "lengthS" INTEGER NOT NULL,
    "views" INTEGER,
    "reach" INTEGER,
    "mediaId" TEXT,
    "insightsAt" TIMESTAMP(3),

    CONSTRAINT "ReelVariant_pkey" PRIMARY KEY ("reelId")
);

-- CreateIndex
CREATE INDEX "VariantGroup_workspaceId_createdAt_idx" ON "VariantGroup"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "VariantGroup_sourceReelId_idx" ON "VariantGroup"("sourceReelId");

-- CreateIndex
CREATE INDEX "ReelVariant_groupId_idx" ON "ReelVariant"("groupId");

-- AddForeignKey
ALTER TABLE "VariantGroup" ADD CONSTRAINT "VariantGroup_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantGroup" ADD CONSTRAINT "VariantGroup_sourceReelId_fkey" FOREIGN KEY ("sourceReelId") REFERENCES "Reel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReelVariant" ADD CONSTRAINT "ReelVariant_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "Reel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReelVariant" ADD CONSTRAINT "ReelVariant_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "VariantGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

