-- Long AI requests run in the background and checked on (ADR 0021). Additive: one new table.
-- CreateTable
CREATE TABLE "AiJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "reelId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiJob_workspaceId_createdAt_idx" ON "AiJob"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiJob" ADD CONSTRAINT "AiJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
