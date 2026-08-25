-- Оплата за місце в груповому занятті.
--
-- Досі Payment був жорстко 1:1 з Booking. Для групи цього замало: заняття —
-- це ОДНА бронь корту на вісьмох людей, і платить кожен за себе. Зняти
-- унікальність з bookingId означало б дозволити два рахунки на одну приватну
-- бронь, тому замість цього зʼявляється друга nullable-колонка seatId:
-- у Postgres NULL не конфліктує з NULL, тож обидва @unique лишаються
-- живими рівно там, де вони потрібні.
--
-- Частина до розділювача згенерована `prisma migrate diff`; після
-- розділювача — те, що у schema.prisma не виражається.

-- AlterTable
ALTER TABLE "BookingSeat" ADD COLUMN     "expiresAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "seatId" UUID,
ALTER COLUMN "bookingId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "BookingSeat_status_expiresAt_idx" ON "BookingSeat"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_seatId_key" ON "Payment"("seatId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "BookingSeat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ────────────────────────────────────────────────────────────────────────
-- Далі — руками.

-- Платіж або за бронь корту, або за місце в групі. Обидва порожні — платіж
-- нізащо; обидва заповнені — платіж за дві речі одразу, і жоден звіт після
-- цього не сходиться. Наявні рядки проходять без правок: у них bookingId
-- заповнений, seatId порожній.
ALTER TABLE "Payment" ADD CONSTRAINT payment_booking_or_seat CHECK (
  num_nonnulls("bookingId", "seatId") = 1
);

-- Один телефон — одне місце. Тепер сюди входить і PENDING: поки гравець
-- платить, місце вже його, і другий рахунок на той самий номер у тому ж
-- занятті виставляти не можна. EXPIRED і CANCELLED, навпаки, не заважають
-- записатись знову — людина передумала, потім передумала назад.
DROP INDEX seat_one_per_phone;
CREATE UNIQUE INDEX seat_one_per_phone
  ON "BookingSeat" ("bookingId", "customerPhone")
  WHERE status IN ('BOOKED', 'PENDING');
