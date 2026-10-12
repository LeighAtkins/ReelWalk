-- Plans and Stripe billing.
CREATE TYPE "Plan" AS ENUM ('FREE', 'AGENT', 'OFFICE');

ALTER TABLE "Workspace"
    ADD COLUMN "plan" "Plan" NOT NULL DEFAULT 'FREE',
    ADD COLUMN "compedPlan" "Plan",
    ADD COLUMN "compedUntil" TIMESTAMP(3),
    ADD COLUMN "stripeCustomerId" TEXT,
    ADD COLUMN "stripeSubscriptionId" TEXT,
    ADD COLUMN "planRenewsAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Workspace_stripeCustomerId_key" ON "Workspace"("stripeCustomerId");
CREATE UNIQUE INDEX "Workspace_stripeSubscriptionId_key" ON "Workspace"("stripeSubscriptionId");

-- Stripe delivers each event at least once; the id makes a second delivery a no-op.
CREATE TABLE "BillingEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);
