-- Admin pages are gated on a column, not on an email claim that signup never verifies.
ALTER TABLE "User" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT false;
