-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('WIDGET', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN');

-- CreateEnum
CREATE TYPE "PassType" AS ENUM ('PACKAGE', 'UNLIMITED');

-- CreateTable
CREATE TABLE "Club" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Kyiv',
    "phone" TEXT,
    "slotMinutes" INTEGER NOT NULL DEFAULT 60,
    "leadTimeMinutes" INTEGER NOT NULL DEFAULT 60,
    "horizonDays" INTEGER NOT NULL DEFAULT 14,
    "autoConfirm" BOOLEAN NOT NULL DEFAULT true,
    "telegramChatId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "trialEndsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Club_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubHours" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "openMinute" INTEGER NOT NULL,
    "closeMinute" INTEGER NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ClubHours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Court" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "pricePerHour" INTEGER NOT NULL DEFAULT 0,
    "slotMinutes" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Court_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "courtId" UUID NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "comment" TEXT,
    "customerId" UUID,
    "startTime" TIMESTAMPTZ(3) NOT NULL,
    "endTime" TIMESTAMPTZ(3) NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'CONFIRMED',
    "source" "BookingSource" NOT NULL DEFAULT 'WIDGET',
    "priceTotal" INTEGER NOT NULL DEFAULT 0,
    "cancelToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Block" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "courtId" UUID,
    "reason" TEXT,
    "startTime" TIMESTAMPTZ(3) NOT NULL,
    "endTime" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'OWNER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "phoneTail" TEXT NOT NULL,
    "telegramChatId" TEXT,
    "note" TEXT,
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pass" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "type" "PassType" NOT NULL,
    "totalSessions" INTEGER,
    "usedSessions" INTEGER NOT NULL DEFAULT 0,
    "validFrom" TIMESTAMPTZ(3) NOT NULL,
    "validUntil" TIMESTAMPTZ(3) NOT NULL,
    "price" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Pass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PassUsage" (
    "id" UUID NOT NULL,
    "passId" UUID NOT NULL,
    "bookingId" UUID,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by" TEXT NOT NULL DEFAULT 'SYSTEM',
    "revertedAt" TIMESTAMP(3),

    CONSTRAINT "PassUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Club_slug_key" ON "Club"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "ClubHours_clubId_weekday_key" ON "ClubHours"("clubId", "weekday");

-- CreateIndex
CREATE INDEX "Court_clubId_isActive_idx" ON "Court"("clubId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_cancelToken_key" ON "Booking"("cancelToken");

-- CreateIndex
CREATE INDEX "Booking_clubId_startTime_idx" ON "Booking"("clubId", "startTime");

-- CreateIndex
CREATE INDEX "Booking_courtId_startTime_idx" ON "Booking"("courtId", "startTime");

-- CreateIndex
CREATE INDEX "Block_clubId_startTime_idx" ON "Block"("clubId", "startTime");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Customer_clubId_phoneTail_idx" ON "Customer"("clubId", "phoneTail");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_clubId_phone_key" ON "Customer"("clubId", "phone");

-- CreateIndex
CREATE INDEX "Pass_clubId_customerId_idx" ON "Pass"("clubId", "customerId");

-- CreateIndex
CREATE INDEX "Pass_clubId_validUntil_idx" ON "Pass"("clubId", "validUntil");

-- CreateIndex
CREATE UNIQUE INDEX "PassUsage_bookingId_key" ON "PassUsage"("bookingId");

-- CreateIndex
CREATE INDEX "PassUsage_passId_idx" ON "PassUsage"("passId");

-- AddForeignKey
ALTER TABLE "ClubHours" ADD CONSTRAINT "ClubHours_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Court" ADD CONSTRAINT "Court_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_courtId_fkey" FOREIGN KEY ("courtId") REFERENCES "Court"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_courtId_fkey" FOREIGN KEY ("courtId") REFERENCES "Court"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pass" ADD CONSTRAINT "Pass_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pass" ADD CONSTRAINT "Pass_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PassUsage" ADD CONSTRAINT "PassUsage_passId_fkey" FOREIGN KEY ("passId") REFERENCES "Pass"("id") ON DELETE CASCADE ON UPDATE CASCADE;
