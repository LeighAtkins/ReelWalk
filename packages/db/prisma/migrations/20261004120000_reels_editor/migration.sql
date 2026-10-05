-- Reels editor: a Reel holds a timeline document, media moves from
-- per-property to a per-workspace library, and render jobs can export a reel.

-- AlterEnum
ALTER TYPE "MediaKind" ADD VALUE 'AUDIO';

-- AlterEnum
ALTER TYPE "RenderJobKind" ADD VALUE 'REEL';

-- AlterTable: workspaceId is added nullable, backfilled from the property,
-- then made required, so existing rows survive the migration.
ALTER TABLE "MediaAsset" ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "height" INTEGER,
ADD COLUMN     "thumbKey" TEXT,
ADD COLUMN     "width" INTEGER,
ADD COLUMN     "workspaceId" TEXT,
ALTER COLUMN "propertyId" DROP NOT NULL;

UPDATE "MediaAsset" m
SET "workspaceId" = p."workspaceId"
FROM "Property" p
WHERE m."propertyId" = p."id";

ALTER TABLE "MediaAsset" ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "RenderJob" ADD COLUMN     "reelId" TEXT;

-- CreateTable
CREATE TABLE "Reel" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "timeline" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "caption" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reel_workspaceId_updatedAt_idx" ON "Reel"("workspaceId", "updatedAt");

-- CreateIndex
CREATE INDEX "MediaAsset_workspaceId_createdAt_idx" ON "MediaAsset"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "RenderJob_reelId_createdAt_idx" ON "RenderJob"("reelId", "createdAt");

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reel" ADD CONSTRAINT "Reel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "Reel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
