-- First-party funnel events and sign-up attribution (ADR 0080). Additive only:
-- one nullable column on "User" and one new table, nothing existing changes.
-- AlterTable
ALTER TABLE "User" ADD COLUMN "attribution" JSONB;

-- CreateTable
CREATE TABLE "FunnelEvent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "userId" TEXT,
    "workspaceId" TEXT,
    "eventKey" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FunnelEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FunnelEvent_eventKey_key" ON "FunnelEvent"("eventKey");

-- CreateIndex
CREATE INDEX "FunnelEvent_name_createdAt_idx" ON "FunnelEvent"("name", "createdAt");

-- CreateIndex
CREATE INDEX "FunnelEvent_userId_idx" ON "FunnelEvent"("userId");

-- AddForeignKey
ALTER TABLE "FunnelEvent" ADD CONSTRAINT "FunnelEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunnelEvent" ADD CONSTRAINT "FunnelEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
