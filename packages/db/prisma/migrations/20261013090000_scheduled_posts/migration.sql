-- Scheduled Instagram posts (ADR 0017). Additive: one enum and one table.
-- CreateEnum
CREATE TYPE "ScheduledPostStatus" AS ENUM ('SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ScheduledPost" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "renderJobId" TEXT NOT NULL,
    "createdById" TEXT,
    "caption" TEXT NOT NULL,
    "coverMs" INTEGER NOT NULL DEFAULT 700,
    "publishAt" TIMESTAMP(3) NOT NULL,
    "status" "ScheduledPostStatus" NOT NULL DEFAULT 'SCHEDULED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "claimToken" TEXT,
    "nextCheckAt" TIMESTAMP(3),
    "containerId" TEXT,
    "containerAt" TIMESTAMP(3),
    "mediaId" TEXT,
    "permalink" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledPost_status_publishAt_idx" ON "ScheduledPost"("status", "publishAt");

-- CreateIndex
CREATE INDEX "ScheduledPost_status_nextCheckAt_idx" ON "ScheduledPost"("status", "nextCheckAt");

-- CreateIndex
CREATE INDEX "ScheduledPost_workspaceId_publishAt_idx" ON "ScheduledPost"("workspaceId", "publishAt");

-- CreateIndex
CREATE INDEX "ScheduledPost_renderJobId_idx" ON "ScheduledPost"("renderJobId");

-- AddForeignKey
ALTER TABLE "ScheduledPost" ADD CONSTRAINT "ScheduledPost_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledPost" ADD CONSTRAINT "ScheduledPost_renderJobId_fkey" FOREIGN KEY ("renderJobId") REFERENCES "RenderJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledPost" ADD CONSTRAINT "ScheduledPost_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

