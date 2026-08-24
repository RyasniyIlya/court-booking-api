-- Групові заняття.
--
-- Групове заняття — це ОДНА бронь корту, до якої записуються люди. Саме так,
-- а не окремою таблицею занять: booking_no_overlap (EXCLUDE USING gist) —
-- головна гарантія схеми, і вона працює тільки в межах однієї таблиці.
-- Контейнер групи займає корт рівно один раз, учасники лежать у BookingSeat
-- і власного інтервалу часу не мають, тому подвійний продаж години
-- лишається неможливим без жодних винятків із правила.
--
-- Частина нижче до розділювача згенерована `prisma migrate diff`; після
-- розділювача — те, що у schema.prisma не виражається, і тому написане
-- руками, як у 20260813090000_no_double_booking.

-- CreateEnum
CREATE TYPE "SeatStatus" AS ENUM ('BOOKED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "capacity" INTEGER,
ADD COLUMN     "pricePerSeat" INTEGER,
ADD COLUMN     "title" TEXT,
ALTER COLUMN "customerName" DROP NOT NULL,
ALTER COLUMN "customerPhone" DROP NOT NULL;

-- CreateTable
CREATE TABLE "BookingSeat" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "customerId" UUID,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "comment" TEXT,
    "status" "SeatStatus" NOT NULL DEFAULT 'BOOKED',
    "source" "BookingSource" NOT NULL DEFAULT 'WIDGET',
    "price" INTEGER NOT NULL DEFAULT 0,
    "cancelToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "BookingSeat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingSeat_cancelToken_key" ON "BookingSeat"("cancelToken");

-- CreateIndex
CREATE INDEX "BookingSeat_bookingId_status_idx" ON "BookingSeat"("bookingId", "status");

-- CreateIndex
CREATE INDEX "BookingSeat_customerId_idx" ON "BookingSeat"("customerId");

-- AddForeignKey
ALTER TABLE "BookingSeat" ADD CONSTRAINT "BookingSeat_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingSeat" ADD CONSTRAINT "BookingSeat_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ────────────────────────────────────────────────────────────────────────
-- Далі — руками: CHECK і частковий унікальний індекс у schema.prisma не
-- виражаються, а без них nullable customerName відкриває стан «ні імені,
-- ні назви», який нікому не видно і ніхто не полагодить.

-- Бронь або приватна (є клієнт, немає місткості), або групова (є місткість
-- і назва). Наявні броні проходять перевірку без правок: у них capacity
-- порожня, а імʼя й телефон заповнені.
ALTER TABLE "Booking" ADD CONSTRAINT booking_private_or_group CHECK (
  ("capacity" IS NULL AND "customerName" IS NOT NULL AND "customerPhone" IS NOT NULL)
  OR
  ("capacity" > 0 AND "title" IS NOT NULL)
);

-- Один телефон — одне місце в занятті. Частковий, бо скасоване місце не
-- має заважати записатись знову: людина передумала, потім передумала назад.
CREATE UNIQUE INDEX seat_one_per_phone
  ON "BookingSeat" ("bookingId", "customerPhone")
  WHERE status = 'BOOKED';
