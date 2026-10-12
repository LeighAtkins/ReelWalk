-- A sound from Instagram's library on a scheduled post (ADR 0018). Additive: nullable columns only.
-- AlterTable
ALTER TABLE "ScheduledPost" ADD COLUMN     "audioArtist" TEXT,
ADD COLUMN     "audioId" TEXT,
ADD COLUMN     "audioTitle" TEXT,
ADD COLUMN     "audioVolume" INTEGER,
ADD COLUMN     "videoVolume" INTEGER;
