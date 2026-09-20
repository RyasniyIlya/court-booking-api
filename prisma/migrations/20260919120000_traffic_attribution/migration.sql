-- Облік джерела трафіку: звідки приходять брони й клієнти.
--
-- Міграція навмисно тільки додає: жодного DROP, жодного NOT NULL без
-- значення за замовчуванням. Наявні броні лишаються з NULL у нових
-- колонках, і це правильно — до появи обліку джерело ніхто не питав, тож
-- вигадувати їм канал не можна. У звітах такі рядки йдуть як «невідомо»,
-- а не як «прямий захід».

-- ── Нові канали запису ──────────────────────────────────────────────────
--
-- Доти бронь із Telegram-бота й з кабінету гравця писалась як WIDGET, і
-- канал бота зливався з сайтом: питання «чи потрібен нам бот» не мало
-- відповіді в цифрах. ADD VALUE безпечний — наявні рядки не чіпає.
ALTER TYPE "BookingSource" ADD VALUE IF NOT EXISTS 'TELEGRAM_BOT';
ALTER TYPE "BookingSource" ADD VALUE IF NOT EXISTS 'PLAYER_APP';

-- ── Зведений канал ──────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TrafficChannel') THEN
    CREATE TYPE "TrafficChannel" AS ENUM (
      'ADS', 'SOCIAL', 'SEARCH', 'MESSAGING', 'REFERRAL', 'BOT', 'RECEPTION', 'DIRECT'
    );
  END IF;
END
$$;

-- ── Останній дотик: що спрацювало саме на цю бронь ──────────────────────
ALTER TABLE "Booking"
  ADD COLUMN IF NOT EXISTS "trafficChannel" "TrafficChannel",
  ADD COLUMN IF NOT EXISTS "utmSource"      TEXT,
  ADD COLUMN IF NOT EXISTS "utmMedium"      TEXT,
  ADD COLUMN IF NOT EXISTS "utmCampaign"    TEXT,
  ADD COLUMN IF NOT EXISTS "referrerHost"   TEXT;

-- ── Перший дотик: що привело цю людину в клуб ───────────────────────────
ALTER TABLE "Customer"
  ADD COLUMN IF NOT EXISTS "firstChannel"      "TrafficChannel",
  ADD COLUMN IF NOT EXISTS "firstUtmSource"    TEXT,
  ADD COLUMN IF NOT EXISTS "firstUtmMedium"    TEXT,
  ADD COLUMN IF NOT EXISTS "firstUtmCampaign"  TEXT,
  ADD COLUMN IF NOT EXISTS "firstReferrerHost" TEXT;

-- ── Індекси під два звіти ───────────────────────────────────────────────
--
-- «Виручка за каналами» групує броні за каналом у межах періоду,
-- «що приводить нових» — картки за першим дотиком. Обидва запити інакше
-- сканували б таблицю клубу цілком.
CREATE INDEX IF NOT EXISTS "Booking_clubId_trafficChannel_startTime_idx"
  ON "Booking" ("clubId", "trafficChannel", "startTime");

CREATE INDEX IF NOT EXISTS "Customer_clubId_firstChannel_idx"
  ON "Customer" ("clubId", "firstChannel");
