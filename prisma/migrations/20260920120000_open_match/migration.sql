-- Відкрита гра: гравцю не вистачає партнерів на свій рівень.
--
-- Міграція тільки додає: нових таблиць немає, наявні броні не чіпаються.
-- Відкрита гра — це групове заняття з прапорцем, а не окрема сутність:
-- місця, ціна за людину, оплата кожним своїм телефоном і автозакриття при
-- заповненні вже працюють у групах (див. ГРУПОВІ-ЗАНЯТТЯ.md). Друга
-- реалізація всього цього заради одного прапорця коштувала б дорожче за
-- саму фічу.

-- ── Ігровий рівень ──────────────────────────────────────────────────────
--
-- Шкала падельна (2.0–4.5), бо гравці вже міряють себе саме нею.
-- Не плутати з внутрішнім рівнем клубу (Новачок/Аматор/Завсідник): той про
-- звичку ходити, цей — про гру.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SkillLevel') THEN
    CREATE TYPE "SkillLevel" AS ENUM ('D', 'C', 'C_PLUS', 'B', 'B_PLUS');
  END IF;
END
$$;

ALTER TABLE "Customer"
  ADD COLUMN IF NOT EXISTS "skillLevel" "SkillLevel";

-- ── Сама гра ────────────────────────────────────────────────────────────
ALTER TABLE "Booking"
  ADD COLUMN IF NOT EXISTS "isOpenMatch" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "levelMin" "SkillLevel",
  ADD COLUMN IF NOT EXISTS "levelMax" "SkillLevel";

-- Відкрита гра без місць неможлива: до неї нема куди записатись.
-- Перевірка в базі, а не лише в коді, бо броні створюються з чотирьох
-- місць (кабінет, віджет, бот, серії), і забути прапорець легко.
ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS booking_open_match_is_group;
ALTER TABLE "Booking" ADD CONSTRAINT booking_open_match_is_group CHECK (
  NOT "isOpenMatch" OR "capacity" IS NOT NULL
);

-- Віджет показує відкриті ігри окремим списком «до кого приєднатись»,
-- завжди в межах клубу й дня.
CREATE INDEX IF NOT EXISTS "Booking_clubId_isOpenMatch_startTime_idx"
  ON "Booking" ("clubId", "isOpenMatch", "startTime");
