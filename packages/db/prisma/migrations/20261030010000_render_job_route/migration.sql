-- Local rendering (ADR 0094). Run it BEFORE deploying the code that needs it: the new Prisma client selects
-- RenderJob.route and .interruptions on every read of a render job, so without them every render path fails.
-- The code from before this migration ignores the new columns and the new table, so applying it early is safe.
--
-- RenderJob is small (about 2.6 MB in production on 2026-10-30), so the plain CREATE INDEX below takes a
-- moment. The lock timeout is transaction-scoped (SET LOCAL, never a session setting through a pooler): if a
-- long query holds RenderJob, the migration fails fast instead of queueing every export behind it, and can
-- simply be run again.
SET LOCAL lock_timeout = '5s';

-- AlterTable: the queue each job's current generation was sent to, and how many times a shutdown handed it
-- back. Every existing job is a cloud job with no interruptions.
ALTER TABLE "RenderJob" ADD COLUMN "route" TEXT NOT NULL DEFAULT 'cloud';
ALTER TABLE "RenderJob" ADD COLUMN "interruptions" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex: the fallback's sweep over local jobs.
CREATE INDEX "RenderJob_route_status_idx" ON "RenderJob"("route", "status");

-- CreateTable: objects render runs uploaded, so losing runs' files can be deleted.
CREATE TABLE "RenderArtifact" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'run',
    "workspaceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RenderArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RenderArtifact_key_key" ON "RenderArtifact"("key");
CREATE INDEX "RenderArtifact_kind_createdAt_idx" ON "RenderArtifact"("kind", "createdAt");
CREATE INDEX "RenderArtifact_workspaceId_idx" ON "RenderArtifact"("workspaceId");

-- AddForeignKey
ALTER TABLE "RenderArtifact" ADD CONSTRAINT "RenderArtifact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
