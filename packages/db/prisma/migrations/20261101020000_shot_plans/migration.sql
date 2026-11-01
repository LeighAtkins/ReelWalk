-- Shot plans (ADR 0104): an AI sequence planned shot by shot, storyboarded, then made one take at a time.
-- A new table only, nothing existing is altered, so it is safe to apply before or after the code that uses it.

-- CreateTable
CREATE TABLE "ShotPlan" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "waitingFor" TEXT,
    "plan" JSONB NOT NULL,
    "state" JSONB NOT NULL,
    "issues" JSONB,
    "approval" TEXT NOT NULL DEFAULT 'storyboard',
    "budgetCredits" INTEGER NOT NULL,
    "presenterId" TEXT,
    "reelId" TEXT,
    "error" TEXT,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShotPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShotPlan_workspaceId_createdAt_idx" ON "ShotPlan"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ShotPlan_status_nextRunAt_idx" ON "ShotPlan"("status", "nextRunAt");

-- AddForeignKey
ALTER TABLE "ShotPlan" ADD CONSTRAINT "ShotPlan_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShotPlan" ADD CONSTRAINT "ShotPlan_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

