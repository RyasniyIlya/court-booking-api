ALTER TABLE "Customer"
ADD COLUMN "birthDate" DATE,
ADD COLUMN "discountPercent" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "CustomerReward" (
  "id" UUID NOT NULL,
  "clubId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "amount" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "actorId" UUID NOT NULL,
  "actorEmail" TEXT NOT NULL,
  "actorRole" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerReward_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CustomerReward_clubId_customerId_createdAt_idx"
ON "CustomerReward"("clubId", "customerId", "createdAt");

ALTER TABLE "Customer" ADD CONSTRAINT "Customer_discountPercent_range"
CHECK ("discountPercent" >= 0 AND "discountPercent" <= 90);
ALTER TABLE "CustomerReward" ADD CONSTRAINT "CustomerReward_amount_positive"
CHECK ("amount" > 0 AND "amount" <= 100000000);
ALTER TABLE "CustomerReward" ADD CONSTRAINT "CustomerReward_customerId_fkey"
FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
