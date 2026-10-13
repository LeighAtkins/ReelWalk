-- Private copies of Instagram sounds for editing against (ADR 0019). Additive:
-- nullable columns, and a unique index that every existing row (all NULL) satisfies.
-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "instagramArtist" TEXT,
ADD COLUMN     "instagramAudioId" TEXT,
ADD COLUMN     "instagramTitle" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_workspaceId_instagramAudioId_key" ON "MediaAsset"("workspaceId", "instagramAudioId");
