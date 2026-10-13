-- Saved briefs for cutting a whole reel (ADR 0020). Additive: one new table.
-- CreateTable
CREATE TABLE "ReelBrief" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReelBrief_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReelBrief_workspaceId_createdAt_idx" ON "ReelBrief"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "ReelBrief" ADD CONSTRAINT "ReelBrief_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
