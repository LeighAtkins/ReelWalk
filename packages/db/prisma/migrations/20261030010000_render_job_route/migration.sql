-- Local rendering (ADR 0094): the queue each render job's current generation was sent to, and how many
-- times a shutdown handed it back. Additive with defaults: every existing job is a cloud job with no
-- interruptions, and code from before this migration ignores both columns.

-- AlterTable
ALTER TABLE "RenderJob" ADD COLUMN "route" TEXT NOT NULL DEFAULT 'cloud';
ALTER TABLE "RenderJob" ADD COLUMN "interruptions" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "RenderJob_route_status_idx" ON "RenderJob"("route", "status");
