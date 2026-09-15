CREATE TABLE "BookingReschedule" (
  "id" UUID NOT NULL,
  "bookingId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "fromCourtId" UUID NOT NULL,
  "toCourtId" UUID NOT NULL,
  "fromStart" TIMESTAMPTZ(3) NOT NULL,
  "fromEnd" TIMESTAMPTZ(3) NOT NULL,
  "toStart" TIMESTAMPTZ(3) NOT NULL,
  "toEnd" TIMESTAMPTZ(3) NOT NULL,
  "price" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BookingReschedule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookingReschedule_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "BookingReschedule_bookingId_createdAt_idx" ON "BookingReschedule"("bookingId", "createdAt");
