-- Графік змін співробітника кабінету (модератора). Дві нові таблиці й нічого
-- наявного не чіпає, тож накат безпечний на живій базі: клуб без жодного
-- рядка тут поводиться рівно так, як поводився до міграції.

-- CreateTable
CREATE TABLE "StaffHours" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "openMinute" INTEGER NOT NULL,
    "closeMinute" INTEGER NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffHours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffShift" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "kind" "TrainerScheduleExceptionKind" NOT NULL DEFAULT 'WORKING',
    "intervals" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffShift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffHours_userId_idx" ON "StaffHours"("userId");
CREATE UNIQUE INDEX "StaffHours_userId_weekday_key" ON "StaffHours"("userId", "weekday");
CREATE INDEX "StaffShift_userId_date_idx" ON "StaffShift"("userId", "date");
CREATE UNIQUE INDEX "StaffShift_userId_date_key" ON "StaffShift"("userId", "date");

-- Зміна не може початись після того, як скінчилась. Перевірка в базі, а не
-- тільки в зоді: рядок із closeMinute < openMinute зламав би підрахунок
-- «хто на зміні» тихо, і помітили б це вже за стійкою.
ALTER TABLE "StaffHours" ADD CONSTRAINT "staff_hours_span"
  CHECK ("isClosed" OR "closeMinute" > "openMinute");
ALTER TABLE "StaffHours" ADD CONSTRAINT "staff_hours_weekday"
  CHECK ("weekday" BETWEEN 0 AND 6);

-- AddForeignKey
ALTER TABLE "StaffHours" ADD CONSTRAINT "StaffHours_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffShift" ADD CONSTRAINT "StaffShift_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
