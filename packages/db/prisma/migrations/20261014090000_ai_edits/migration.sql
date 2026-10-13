-- Changes asked for in words (ADR 0020). Additive: one new table, nothing else touched.
-- CreateTable
CREATE TABLE "AiEdit" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT,
    "reelId" TEXT,
    "request" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "applied" JSONB NOT NULL,
    "skipped" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiEdit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiEdit_workspaceId_createdAt_idx" ON "AiEdit"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiEdit" ADD CONSTRAINT "AiEdit_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiEdit" ADD CONSTRAINT "AiEdit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiEdit" ADD CONSTRAINT "AiEdit_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "Reel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
