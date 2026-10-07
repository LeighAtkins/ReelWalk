-- Preview renditions for uploaded videos.
ALTER TYPE "RenderJobKind" ADD VALUE 'PREVIEW';
ALTER TABLE "MediaAsset" ADD COLUMN "previewKey" TEXT;
