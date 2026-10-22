-- Instagram Stories and server-side immediate posts (ADR 0065). Additive.
ALTER TYPE "RenderJobKind" ADD VALUE 'STORY';
CREATE TYPE "ScheduledPostKind" AS ENUM ('REEL', 'STORY');

ALTER TABLE "RenderJob" ADD COLUMN "sourceJobId" TEXT;
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "RenderJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "RenderJob_sourceJobId_idx" ON "RenderJob"("sourceJobId");

ALTER TABLE "ScheduledPost" ADD COLUMN "kind" "ScheduledPostKind" NOT NULL DEFAULT 'REEL';
ALTER TABLE "ScheduledPost" ADD COLUMN "afterPostId" TEXT;
ALTER TABLE "ScheduledPost" ADD CONSTRAINT "ScheduledPost_afterPostId_fkey" FOREIGN KEY ("afterPostId") REFERENCES "ScheduledPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ScheduledPost_afterPostId_idx" ON "ScheduledPost"("afterPostId");
