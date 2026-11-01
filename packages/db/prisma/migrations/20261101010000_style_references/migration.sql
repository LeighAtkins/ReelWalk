-- Style references (ADR 0102): reels the owner downloaded and shared with ReelWalk to follow their style.
-- A new table only, nothing existing is altered, so it is safe to apply before or after the code that uses it.

-- CreateTable
CREATE TABLE "StyleReference" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'measuring',
    "analysis" JSONB,
    "recipe" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StyleReference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StyleReference_mediaAssetId_key" ON "StyleReference"("mediaAssetId");
CREATE INDEX "StyleReference_workspaceId_createdAt_idx" ON "StyleReference"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "StyleReference" ADD CONSTRAINT "StyleReference_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StyleReference" ADD CONSTRAINT "StyleReference_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
