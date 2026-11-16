CREATE TABLE "ListingCampaign" (
 "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "sourceReelId" TEXT NOT NULL,
 "requestKey" TEXT NOT NULL, "title" TEXT NOT NULL, "facts" JSONB NOT NULL,
 "revision" INTEGER NOT NULL DEFAULT 0, "lastRequestKey" TEXT, "lastRequestHash" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "ListingCampaign_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ListingCampaign_workspaceId_requestKey_key" ON "ListingCampaign"("workspaceId", "requestKey");
CREATE INDEX "ListingCampaign_workspaceId_updatedAt_idx" ON "ListingCampaign"("workspaceId", "updatedAt");
CREATE TABLE "CampaignOutput" (
 "id" TEXT NOT NULL, "campaignId" TEXT NOT NULL, "reelId" TEXT NOT NULL, "role" TEXT NOT NULL,
 "appliedRevision" INTEGER NOT NULL DEFAULT 0, "boundCaption" TEXT NOT NULL,
 CONSTRAINT "CampaignOutput_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CampaignOutput_reelId_key" ON "CampaignOutput"("reelId");
CREATE UNIQUE INDEX "CampaignOutput_campaignId_role_key" ON "CampaignOutput"("campaignId", "role");
ALTER TABLE "CampaignOutput" ADD CONSTRAINT "CampaignOutput_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "ListingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "CampaignReview" (
 "id" TEXT NOT NULL, "outputId" TEXT NOT NULL, "exportId" TEXT NOT NULL, "reelRevision" INTEGER NOT NULL,
 "factRevision" INTEGER NOT NULL, "tokenHash" TEXT NOT NULL, "caption" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" TIMESTAMP(3) NOT NULL,
 "revokedAt" TIMESTAMP(3), "approvedAt" TIMESTAMP(3), "reviewerName" TEXT,
 CONSTRAINT "CampaignReview_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CampaignReview_tokenHash_key" ON "CampaignReview"("tokenHash");
CREATE INDEX "CampaignReview_outputId_createdAt_idx" ON "CampaignReview"("outputId", "createdAt");
ALTER TABLE "CampaignReview" ADD CONSTRAINT "CampaignReview_outputId_fkey" FOREIGN KEY ("outputId") REFERENCES "CampaignOutput"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "CampaignReviewComment" (
 "id" TEXT NOT NULL, "reviewId" TEXT NOT NULL, "requestKey" TEXT NOT NULL,
 "name" TEXT NOT NULL, "message" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CampaignReviewComment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CampaignReviewComment_reviewId_requestKey_key" ON "CampaignReviewComment"("reviewId", "requestKey");
ALTER TABLE "CampaignReviewComment" ADD CONSTRAINT "CampaignReviewComment_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "CampaignReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ListingCampaign" ALTER COLUMN "sourceReelId" DROP NOT NULL;
ALTER TABLE "ListingCampaign" ADD CONSTRAINT "ListingCampaign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ListingCampaign" ADD CONSTRAINT "ListingCampaign_sourceReelId_fkey" FOREIGN KEY ("sourceReelId") REFERENCES "Reel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CampaignOutput" ADD CONSTRAINT "CampaignOutput_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "Reel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignReview" ADD CONSTRAINT "CampaignReview_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "RenderJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ListingCampaign" ADD COLUMN "creationHash" TEXT NOT NULL;
