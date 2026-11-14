CREATE TABLE "AiKeyframe" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL, "inputHash" TEXT NOT NULL, "requestHash" TEXT NOT NULL,
  "input" JSONB NOT NULL, "snapshot" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "credits" INTEGER NOT NULL DEFAULT 1, "creditRefunded" BOOLEAN NOT NULL DEFAULT false, "heldCostCents" INTEGER NOT NULL DEFAULT 100,
  "grantId" TEXT NOT NULL, "submittedAt" TIMESTAMP(3), "responseKey" TEXT, "responseHash" TEXT,
  "candidateKey" TEXT, "candidateHash" TEXT, "assetId" TEXT, "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiKeyframe_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiKeyframe_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AiKeyframe_workspaceId_requestId_key" ON "AiKeyframe"("workspaceId", "requestId");
CREATE UNIQUE INDEX "AiKeyframe_assetId_key" ON "AiKeyframe"("assetId");
CREATE INDEX "AiKeyframe_workspaceId_createdAt_idx" ON "AiKeyframe"("workspaceId", "createdAt");
CREATE INDEX "AiKeyframe_status_createdAt_idx" ON "AiKeyframe"("status", "createdAt");
