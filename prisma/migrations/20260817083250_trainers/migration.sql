-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "trainerId" UUID,
ADD COLUMN     "trainerPrice" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Trainer" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "pricePerHour" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trainer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Trainer_clubId_isActive_idx" ON "Trainer"("clubId", "isActive");

-- CreateIndex
CREATE INDEX "Booking_trainerId_startTime_idx" ON "Booking"("trainerId", "startTime");

-- AddForeignKey
ALTER TABLE "Trainer" ADD CONSTRAINT "Trainer_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_trainerId_fkey" FOREIGN KEY ("trainerId") REFERENCES "Trainer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
