-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('MONTH', 'QUARTER', 'YEAR');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('ISSUED', 'PAID', 'VOID');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'TRAINER';

-- AlterTable
ALTER TABLE "Club" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "billingNote" TEXT,
ADD COLUMN     "billingPeriod" "BillingPeriod" NOT NULL DEFAULT 'MONTH',
ADD COLUMN     "brandColor" TEXT,
ADD COLUMN     "paidUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "pinFails" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pinLockedUntil" TIMESTAMP(3),
ADD COLUMN     "pinModerHash" TEXT,
ADD COLUMN     "pinOwnerHash" TEXT,
ADD COLUMN     "trainerId" UUID;

-- CreateTable
CREATE TABLE "ClubInvoice" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "method" TEXT,
    "note" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "ClubInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClubInvoice_clubId_periodTo_idx" ON "ClubInvoice"("clubId", "periodTo");

-- AddForeignKey
ALTER TABLE "ClubInvoice" ADD CONSTRAINT "ClubInvoice_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_trainerId_fkey" FOREIGN KEY ("trainerId") REFERENCES "Trainer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
