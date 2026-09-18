-- Прокат інвентарю при броні. Нічого наявного не змінює: нові колонки з
-- дефолтами й нова таблиця, тож накат безпечний на живій базі.

-- CreateEnum
CREATE TYPE "RentMode" AS ENUM ('FIXED', 'HOURLY');

-- CreateEnum
CREATE TYPE "RentalStatus" AS ENUM ('RESERVED', 'ISSUED', 'RETURNED');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "rentalTotal" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN "rentMode" "RentMode" NOT NULL DEFAULT 'FIXED',
ADD COLUMN "rentPrice" INTEGER;

-- CreateTable
CREATE TABLE "BookingRental" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "pointKey" TEXT NOT NULL DEFAULT 'main',
    "bookingId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "itemName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "mode" "RentMode" NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "RentalStatus" NOT NULL DEFAULT 'RESERVED',
    "issuedAt" TIMESTAMP(3),
    "issuedBy" TEXT,
    "returnedAt" TIMESTAMP(3),
    "returnedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingRental_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingRental_clubId_itemId_idx" ON "BookingRental"("clubId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingRental_bookingId_itemId_key" ON "BookingRental"("bookingId", "itemId");

-- AddForeignKey
ALTER TABLE "BookingRental" ADD CONSTRAINT "BookingRental_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRental" ADD CONSTRAINT "BookingRental_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRental" ADD CONSTRAINT "BookingRental_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Інваріанти, яких Prisma не виражає. Гроші й кількість не бувають
-- відʼємними; нульова ціна допустима («ракетки безкоштовно для учнів»).
ALTER TABLE "BookingRental" ADD CONSTRAINT booking_rental_quantity_positive CHECK ("quantity" > 0);
ALTER TABLE "BookingRental" ADD CONSTRAINT booking_rental_money_non_negative CHECK ("unitPrice" >= 0 AND "amount" >= 0);
ALTER TABLE "InventoryItem" ADD CONSTRAINT inventory_rent_price_non_negative CHECK ("rentPrice" IS NULL OR "rentPrice" >= 0);
ALTER TABLE "Booking" ADD CONSTRAINT booking_rental_total_non_negative CHECK ("rentalTotal" >= 0);
