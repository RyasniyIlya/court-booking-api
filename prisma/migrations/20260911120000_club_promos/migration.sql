-- Акційні ціни клубу: «щасливі години», акційні дні та день народження.
--
-- Перевірки тримаємо в базі, а не тільки в роуті: правило знижки живе
-- довше за код, який його завів, і акція з −300% або з вивернутим часом
-- не має пережити навіть прямий INSERT з консолі.

CREATE TYPE "PromoKind" AS ENUM ('WEEKLY', 'DATES', 'BIRTHDAY');
CREATE TYPE "PromoDiscount" AS ENUM ('PERCENT', 'PRICE');

CREATE TABLE "Promo" (
  "id"            UUID NOT NULL,
  "clubId"        UUID NOT NULL,
  "title"         TEXT NOT NULL,
  "kind"          "PromoKind" NOT NULL DEFAULT 'WEEKLY',
  "weekdays"      INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "dateFrom"      DATE,
  "dateTo"        DATE,
  "daysBefore"    INTEGER NOT NULL DEFAULT 0,
  "daysAfter"     INTEGER NOT NULL DEFAULT 0,
  "startMinute"   INTEGER NOT NULL DEFAULT 0,
  "endMinute"     INTEGER NOT NULL DEFAULT 1440,
  "discountType"  "PromoDiscount" NOT NULL DEFAULT 'PERCENT',
  "discountValue" INTEGER NOT NULL DEFAULT 0,
  "courtIds"      UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Promo_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Promo_clubId_isActive_idx" ON "Promo"("clubId", "isActive");

ALTER TABLE "Promo" ADD CONSTRAINT "Promo_clubId_fkey"
FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Вікно часу: кінець пізніше за початок, обидва в межах доби.
ALTER TABLE "Promo" ADD CONSTRAINT "Promo_time_window"
CHECK ("startMinute" >= 0 AND "endMinute" > "startMinute" AND "endMinute" <= 1440);

-- Стеля знижки — 90%. «Безкоштовно» майже завжди не акція, а зайвий нуль
-- у полі; клубу, який роздає час даром, простіше закрити його блоком.
ALTER TABLE "Promo" ADD CONSTRAINT "Promo_discount_range"
CHECK (
  "discountValue" >= 0
  AND ("discountType" <> 'PERCENT' OR "discountValue" <= 90)
);

-- 60 днів у бік — це вже майже чотири місяці іменин на рік. Далі це не
-- акція на день народження, а тихий новий тариф для частини гравців.
ALTER TABLE "Promo" ADD CONSTRAINT "Promo_birthday_window"
CHECK (
  "daysBefore" >= 0 AND "daysBefore" <= 60
  AND "daysAfter" >= 0 AND "daysAfter" <= 60
);

-- Акція без жодного дня тижня зберігається без помилки і просто ніколи не
-- спрацьовує — найгірший вид поломки, бо клуб дізнається про неї з виторгу.
ALTER TABLE "Promo" ADD CONSTRAINT "Promo_kind_fields"
CHECK (
  ("kind" = 'WEEKLY'   AND array_length("weekdays", 1) BETWEEN 1 AND 7)
  OR ("kind" = 'DATES' AND "dateFrom" IS NOT NULL AND "dateTo" IS NOT NULL AND "dateTo" >= "dateFrom")
  OR "kind" = 'BIRTHDAY'
);
