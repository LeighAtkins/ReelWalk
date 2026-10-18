-- A credit now buys 4 seconds instead of one 8-second clip, so every existing balance doubles
-- to keep its value. In-flight jobs keep the 8-second length they were charged for.
ALTER TABLE "AiGeneration" ADD COLUMN "durationSeconds" INTEGER NOT NULL DEFAULT 8,
  ADD COLUMN "credits" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "grantDebits" JSONB;
UPDATE "AiCreditGrant" SET "amount" = "amount" * 2, "remaining" = "remaining" * 2;
