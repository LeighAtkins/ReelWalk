-- Presenter identity kit (ADR 0056). Additive only.
CREATE TABLE "Presenter" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "portraitAssetId" TEXT NOT NULL,
    "fullBodyAssetId" TEXT NOT NULL,
    "faceCropKey" TEXT,
    "faceHeightPx" INTEGER,
    "faceCropError" TEXT,
    "faceCropTries" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "voice" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Presenter_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Presenter_workspaceId_createdAt_idx" ON "Presenter"("workspaceId", "createdAt");
-- At most one default kit per workspace.
CREATE UNIQUE INDEX "Presenter_one_default_per_workspace" ON "Presenter"("workspaceId") WHERE "isDefault";
ALTER TABLE "Presenter" ADD CONSTRAINT "Presenter_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiGeneration" ADD COLUMN "presenterId" TEXT,
ADD COLUMN "referenceDepth" INTEGER,
ADD COLUMN "identityScore" DOUBLE PRECISION,
ADD COLUMN "identityChecks" JSONB,
ADD COLUMN "failureCode" TEXT;
