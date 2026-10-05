-- Tours: a home's floor plan, with media located on it.

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "room" TEXT,
ADD COLUMN     "spot" JSONB,
ADD COLUMN     "tourId" TEXT;

-- CreateTable
CREATE TABLE "Tour" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "sourceUrl" TEXT,
    "license" TEXT,
    "attribution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tour_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tour_workspaceId_idx" ON "Tour"("workspaceId");

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tour" ADD CONSTRAINT "Tour_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
