-- Вільний майбутній слот можна бронювати аж до моменту його початку.
-- Значення лишається налаштовуваним: оператор клубу може повернути запас.
ALTER TABLE "Club" ALTER COLUMN "leadTimeMinutes" SET DEFAULT 0;
UPDATE "Club" SET "leadTimeMinutes" = 0;
