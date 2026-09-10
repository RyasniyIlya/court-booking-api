ALTER TABLE "Customer" ADD COLUMN "email" TEXT;

CREATE INDEX "Customer_clubId_email_idx"
ON "Customer"("clubId", "email");
