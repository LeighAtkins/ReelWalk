-- "Popular now" music candidates (ADR 0058). Additive only: one new table.
CREATE TABLE "MusicCandidate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "isrc" TEXT,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "moods" JSONB NOT NULL,
    "playlists" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "igAudioId" TEXT,
    "igAudioType" TEXT,
    "igTitle" TEXT,
    "igArtist" TEXT,
    "igDurationMs" INTEGER,
    "igMatch" TEXT,
    "igConfidence" DOUBLE PRECISION,
    "trendingRank" INTEGER,
    "bpm" DOUBLE PRECISION,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "matchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MusicCandidate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MusicCandidate_key_key" ON "MusicCandidate"("key");
CREATE INDEX "MusicCandidate_igAudioId_idx" ON "MusicCandidate"("igAudioId");
CREATE INDEX "MusicCandidate_score_idx" ON "MusicCandidate"("score");
