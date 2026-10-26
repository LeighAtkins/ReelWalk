-- Per-moment shot analysis of uploaded videos (ADR 0086). Additive only: one nullable column on
-- "MediaAsset"; nothing existing changes, and an asset without it simply has no analysis yet.
-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN "shotAnalysis" JSONB;
