-- Telegram для гравця: привʼязка з профілю, нагадування з «Прийду / Скасувати»
-- і черга на зайнятий слот корту.
--
-- Тільки додавання: нові колонки порожні, наявні броні вважаються такими,
-- що нагадування не отримували (у вікно 3 години потраплять лише майбутні).

CREATE TYPE "WaitlistStatus" AS ENUM ('WAITING', 'OFFERED', 'DONE', 'CANCELLED', 'EXPIRED');

ALTER TABLE "Booking"
  ADD COLUMN "playerRemindedAt"  TIMESTAMP(3),
  ADD COLUMN "playerConfirmedAt" TIMESTAMP(3);

ALTER TABLE "BookingSeat"
  ADD COLUMN "playerRemindedAt"  TIMESTAMP(3),
  ADD COLUMN "playerConfirmedAt" TIMESTAMP(3);

ALTER TABLE "Customer"
  ADD COLUMN "tgLinkCode"  TEXT,
  ADD COLUMN "tgLinkUntil" TIMESTAMP(3);

CREATE UNIQUE INDEX "Customer_tgLinkCode_key" ON "Customer"("tgLinkCode");
CREATE INDEX "Customer_telegramChatId_idx" ON "Customer"("telegramChatId");

CREATE TABLE "WaitlistEntry" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "courtId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "startTime" TIMESTAMPTZ(3) NOT NULL,
    "endTime" TIMESTAMPTZ(3) NOT NULL,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'WAITING',
    "offeredAt" TIMESTAMP(3),
    "offerUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WaitlistEntry_status_startTime_idx" ON "WaitlistEntry"("status", "startTime");
CREATE INDEX "WaitlistEntry_courtId_startTime_idx" ON "WaitlistEntry"("courtId", "startTime");
CREATE INDEX "WaitlistEntry_customerId_status_idx" ON "WaitlistEntry"("customerId", "status");

ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_courtId_fkey" FOREIGN KEY ("courtId") REFERENCES "Court"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
