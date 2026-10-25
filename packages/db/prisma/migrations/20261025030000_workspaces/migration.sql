-- Workspaces: one sign-in, several workspaces (ADR 0079).
-- Additive, plus one reshaped unique index on OAuthGrant. Existing rows are backfilled in this file.

-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'EDITOR');

-- AlterTable: the per-workspace AI switch. Every existing workspace keeps AI on.
ALTER TABLE "Workspace" ADD COLUMN "aiGeneration" TEXT NOT NULL DEFAULT 'on';

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'OWNER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_userId_workspaceId_key" ON "WorkspaceMember"("userId", "workspaceId");
CREATE INDEX "WorkspaceMember_workspaceId_idx" ON "WorkspaceMember"("workspaceId");

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every user owns their home workspace.
INSERT INTO "WorkspaceMember" ("id", "userId", "workspaceId", "role", "createdAt")
SELECT 'wm_' || "id", "id", "workspaceId", 'OWNER', "createdAt" FROM "User";

-- OAuthGrant: the workspace a connection acts on. Existing grants act on their person's home workspace.
ALTER TABLE "OAuthGrant" ADD COLUMN "workspaceId" TEXT;
UPDATE "OAuthGrant" SET "workspaceId" = (SELECT "workspaceId" FROM "User" WHERE "User"."id" = "OAuthGrant"."userId");
ALTER TABLE "OAuthGrant" ALTER COLUMN "workspaceId" SET NOT NULL;

DROP INDEX "OAuthGrant_userId_clientId_key";
CREATE UNIQUE INDEX "OAuthGrant_userId_clientId_workspaceId_key" ON "OAuthGrant"("userId", "clientId", "workspaceId");
CREATE INDEX "OAuthGrant_workspaceId_idx" ON "OAuthGrant"("workspaceId");

ALTER TABLE "OAuthGrant" ADD CONSTRAINT "OAuthGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
