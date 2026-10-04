-- Where imported library media came from and under which licence.
ALTER TABLE "MediaAsset" ADD COLUMN     "attribution" TEXT,
ADD COLUMN     "license" TEXT,
ADD COLUMN     "sourceUrl" TEXT;
