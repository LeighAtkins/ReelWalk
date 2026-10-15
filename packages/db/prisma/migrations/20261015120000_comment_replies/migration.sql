-- Keyword comment replies on Instagram (ADR 0026). Additive: three nullable columns, two new tables.
-- AlterTable
ALTER TABLE "SocialAccount" ADD COLUMN "messagingToken" TEXT,
ADD COLUMN "messagingUserId" TEXT,
ADD COLUMN "messagingExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CommentTrigger" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "publicReply" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommentTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommentReply" (
    "id" TEXT NOT NULL,
    "triggerId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "username" TEXT,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENDING',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommentReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommentTrigger_workspaceId_keyword_key" ON "CommentTrigger"("workspaceId", "keyword");

-- CreateIndex
CREATE UNIQUE INDEX "CommentReply_commentId_key" ON "CommentReply"("commentId");

-- CreateIndex
CREATE INDEX "CommentReply_triggerId_createdAt_idx" ON "CommentReply"("triggerId", "createdAt");

-- AddForeignKey
ALTER TABLE "CommentTrigger" ADD CONSTRAINT "CommentTrigger_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentReply" ADD CONSTRAINT "CommentReply_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "CommentTrigger"("id") ON DELETE CASCADE ON UPDATE CASCADE;
