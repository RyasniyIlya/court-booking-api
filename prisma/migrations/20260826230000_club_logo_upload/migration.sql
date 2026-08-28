-- Завантажений логотип клуба.
--
-- Байти в базі, а не файл на диску: у Render файлова система ефемерна.
-- Наявні клуби лишаються з MONOGRAM — логотип необов'язковий, і мовчки
-- перемикати когось на порожню картинку не можна.

CREATE TYPE "LogoMode" AS ENUM ('MONOGRAM', 'IMAGE');

ALTER TABLE "Club" ADD COLUMN "logoData"      BYTEA;
ALTER TABLE "Club" ADD COLUMN "logoMime"      TEXT;
ALTER TABLE "Club" ADD COLUMN "logoUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Club" ADD COLUMN "logoMode"      "LogoMode" NOT NULL DEFAULT 'MONOGRAM';

-- Клуби, які вже вставили посилання на логотип, показували його й до цієї
-- міграції. Якби всі поїхали на MONOGRAM, вони втратили б логотип у мить
-- деплою — тому їм одразу проставляємо IMAGE.
UPDATE "Club" SET "logoMode" = 'IMAGE' WHERE "logoUrl" IS NOT NULL AND "logoUrl" <> '';
