-- Фото тренерів і оцінки за заняття. Тільки додавання: нові таблиці й
-- nullable-колонки, наявні дані не чіпаємо.
ALTER TABLE "Booking" ADD COLUMN "rateAskedAt" TIMESTAMP(3);
ALTER TABLE "BookingSeat" ADD COLUMN "rateAskedAt" TIMESTAMP(3);

CREATE TABLE "TrainerPhoto" (
  "id" UUID NOT NULL,
  "trainerId" UUID NOT NULL,
  "clubId" UUID NOT NULL,
  "data" BYTEA NOT NULL,
  "mime" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TrainerPhoto_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TrainerRating" (
  "id" UUID NOT NULL,
  "clubId" UUID NOT NULL,
  "trainerId" UUID NOT NULL,
  "bookingId" UUID NOT NULL,
  "seatId" UUID,
  "customerId" UUID NOT NULL,
  "score" INTEGER,
  "comment" TEXT,
  "source" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TrainerRating_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trainer_rating_score_range" CHECK ("score" IS NULL OR "score" BETWEEN 1 AND 5)
);

CREATE INDEX "TrainerPhoto_trainerId_sortOrder_idx" ON "TrainerPhoto"("trainerId", "sortOrder");
CREATE UNIQUE INDEX "TrainerRating_bookingId_customerId_key" ON "TrainerRating"("bookingId", "customerId");
CREATE INDEX "TrainerRating_trainerId_createdAt_idx" ON "TrainerRating"("trainerId", "createdAt");
CREATE INDEX "TrainerRating_clubId_createdAt_idx" ON "TrainerRating"("clubId", "createdAt");

ALTER TABLE "TrainerPhoto" ADD CONSTRAINT "TrainerPhoto_trainerId_fkey" FOREIGN KEY ("trainerId") REFERENCES "Trainer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrainerRating" ADD CONSTRAINT "TrainerRating_trainerId_fkey" FOREIGN KEY ("trainerId") REFERENCES "Trainer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrainerRating" ADD CONSTRAINT "TrainerRating_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrainerRating" ADD CONSTRAINT "TrainerRating_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "BookingSeat"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TrainerRating" ADD CONSTRAINT "TrainerRating_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
