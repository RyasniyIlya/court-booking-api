-- Щотижнева акція без жодного дня тижня все ще проходила в базу.
--
-- array_length() порожнього масиву повертає не 0, а NULL, тому умова
-- ставала NULL — а CHECK пропускає все, крім FALSE. Найгірший вид
-- поломки: акція зберігається без помилки і просто ніколи не спрацьовує.

ALTER TABLE "Promo" DROP CONSTRAINT "Promo_kind_fields";

ALTER TABLE "Promo" ADD CONSTRAINT "Promo_kind_fields"
CHECK (
  ("kind" = 'WEEKLY'   AND COALESCE(array_length("weekdays", 1), 0) BETWEEN 1 AND 7)
  OR ("kind" = 'DATES' AND "dateFrom" IS NOT NULL AND "dateTo" IS NOT NULL AND "dateTo" >= "dateFrom")
  OR "kind" = 'BIRTHDAY'
);
