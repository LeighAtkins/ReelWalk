-- Accounts: passwords and sessions.
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;

CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Connected publishing accounts (Instagram).
CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SocialAccount_workspaceId_provider_key" ON "SocialAccount"("workspaceId", "provider");
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Public share links.
ALTER TABLE "Reel" ADD COLUMN "shareToken" TEXT;
CREATE UNIQUE INDEX "Reel_shareToken_key" ON "Reel"("shareToken");

-- The open starter library is visible to every workspace.
ALTER TABLE "MediaAsset" ADD COLUMN "shared" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "MediaAsset_shared_idx" ON "MediaAsset"("shared");
UPDATE "MediaAsset" SET "shared" = true
WHERE "objectKey" LIKE 'library/music/%' OR "objectKey" LIKE 'library/video/%' OR "objectKey" LIKE 'library/pano/%';
