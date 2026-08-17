-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "seriesId" UUID;

-- CreateIndex
CREATE INDEX "Booking_seriesId_idx" ON "Booking"("seriesId");
