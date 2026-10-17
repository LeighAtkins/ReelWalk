-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "aiPaidPeriodStart" TIMESTAMP(3),
ADD COLUMN     "aiPaidPlan" "Plan" NOT NULL DEFAULT 'FREE',
ADD COLUMN     "aiPaidThrough" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AiCreditGrant" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCreditGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiGeneration" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "referenceKey" TEXT,
    "referenceType" TEXT,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "operationName" TEXT,
    "assetId" TEXT,
    "costCents" INTEGER NOT NULL DEFAULT 80,
    "error" TEXT,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "nextPollAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AiGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiSpendBudget" (
    "id" TEXT NOT NULL,
    "reservedCents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AiSpendBudget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiCreditGrant_source_key" ON "AiCreditGrant"("source");

-- CreateIndex
CREATE INDEX "AiCreditGrant_workspaceId_expiresAt_idx" ON "AiCreditGrant"("workspaceId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiGeneration_assetId_key" ON "AiGeneration"("assetId");

-- CreateIndex
CREATE INDEX "AiGeneration_status_nextPollAt_idx" ON "AiGeneration"("status", "nextPollAt");

-- CreateIndex
CREATE INDEX "AiGeneration_workspaceId_createdAt_idx" ON "AiGeneration"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiGeneration_workspaceId_requestId_key" ON "AiGeneration"("workspaceId", "requestId");

-- AddForeignKey
ALTER TABLE "AiCreditGrant" ADD CONSTRAINT "AiCreditGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiGeneration" ADD CONSTRAINT "AiGeneration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiGeneration" ADD CONSTRAINT "AiGeneration_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiGeneration" ADD CONSTRAINT "AiGeneration_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "AiCreditGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
