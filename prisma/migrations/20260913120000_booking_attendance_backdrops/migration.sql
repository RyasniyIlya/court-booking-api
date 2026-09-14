-- Три стадії броні в кабінеті: запис -> оплата -> прийшов / не прийшов.
-- І вибір фону окремо для кабінету та для сторінки клубу.
--
-- Лише додавання колонок із DEFAULT: наявні броні отримують UNKNOWN
-- («ще не відмічено»), наявні клуби — рівно ті фони, що були до вибору.

CREATE TYPE "Attendance" AS ENUM ('UNKNOWN', 'ARRIVED', 'NO_SHOW');
CREATE TYPE "BackdropStyle" AS ENUM ('GRADIENT', 'TABLE_TENNIS', 'PADEL', 'TENNIS', 'PLAIN');

ALTER TABLE "Booking"
  ADD COLUMN "attendance"   "Attendance" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "attendanceAt" TIMESTAMP(3),
  ADD COLUMN "attendanceBy" TEXT;

ALTER TABLE "Club"
  ADD COLUMN "cabinetBackdrop" "BackdropStyle" NOT NULL DEFAULT 'TABLE_TENNIS',
  ADD COLUMN "pageBackdrop"    "BackdropStyle" NOT NULL DEFAULT 'GRADIENT';
