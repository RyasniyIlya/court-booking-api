-- AlterTable
ALTER TABLE "Club" ADD COLUMN     "settlementSettings" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedBy" TEXT,
ADD COLUMN     "createdBy" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "refundRequestedBy" TEXT;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "bonusBalance" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "BookingLedgerEntry" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "seatId" UUID,
    "customerId" UUID,
    "requestId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "account" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "actorId" UUID NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "originalId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingLedgerEntry_clubId_bookingId_seatId_idx" ON "BookingLedgerEntry"("clubId", "bookingId", "seatId");

-- CreateIndex
CREATE INDEX "BookingLedgerEntry_originalId_idx" ON "BookingLedgerEntry"("originalId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingLedgerEntry_clubId_requestId_key" ON "BookingLedgerEntry"("clubId", "requestId");

-- AddForeignKey
ALTER TABLE "BookingLedgerEntry" ADD CONSTRAINT "BookingLedgerEntry_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingLedgerEntry" ADD CONSTRAINT "BookingLedgerEntry_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingLedgerEntry" ADD CONSTRAINT "BookingLedgerEntry_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "BookingSeat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingLedgerEntry" ADD CONSTRAINT "BookingLedgerEntry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Financial invariants also apply to writes outside the HTTP handlers.
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_bonusBalance_nonnegative" CHECK ("bonusBalance" >= 0);
ALTER TABLE "BookingLedgerEntry" ADD CONSTRAINT "BookingLedgerEntry_amount_positive" CHECK ("amount" > 0 AND "amount" <= 100000000);
ALTER TABLE "BookingLedgerEntry" ADD CONSTRAINT "BookingLedgerEntry_kind_valid" CHECK ("kind" IN ('PAYMENT', 'REFUND'));
ALTER TABLE "BookingLedgerEntry" ADD CONSTRAINT "BookingLedgerEntry_method_valid" CHECK ("method" IN ('CASH', 'CARD', 'TRANSFER', 'BONUS'));
ALTER TABLE "BookingLedgerEntry" ADD CONSTRAINT "BookingLedgerEntry_refund_source" CHECK (("kind" = 'REFUND' AND "originalId" IS NOT NULL) OR ("kind" = 'PAYMENT' AND "originalId" IS NULL));
ALTER TABLE "BookingLedgerEntry" ADD CONSTRAINT "BookingLedgerEntry_originalId_fkey" FOREIGN KEY ("originalId") REFERENCES "BookingLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
