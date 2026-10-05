-- Tempo of music assets, for snapping cuts to the beat.
ALTER TABLE "MediaAsset" ADD COLUMN     "beatOffsetMs" INTEGER,
ADD COLUMN     "bpm" DOUBLE PRECISION;
