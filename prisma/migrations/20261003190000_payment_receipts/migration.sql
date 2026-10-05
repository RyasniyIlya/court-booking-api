-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReceiptAiStatus" AS ENUM ('PENDING', 'DONE', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "PaymentReceipt" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "fileData" BYTEA NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedBy" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "aiStatus" "ReceiptAiStatus" NOT NULL DEFAULT 'PENDING',
    "aiResult" JSONB,
    "aiCheckedAt" TIMESTAMP(3),
    "status" "ReceiptStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectReason" TEXT,

    CONSTRAINT "PaymentReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentReceipt_sha256_key" ON "PaymentReceipt"("sha256");

-- CreateIndex
CREATE INDEX "PaymentReceipt_clubId_uploadedAt_idx" ON "PaymentReceipt"("clubId", "uploadedAt");

-- CreateIndex
CREATE INDEX "PaymentReceipt_invoiceId_idx" ON "PaymentReceipt"("invoiceId");

-- CreateIndex
CREATE INDEX "PaymentReceipt_status_uploadedAt_idx" ON "PaymentReceipt"("status", "uploadedAt");

-- AddForeignKey
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "ClubInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
