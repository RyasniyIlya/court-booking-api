-- Пароль профілю гравця на сайті клубу.
-- Лише nullable-колонки й лічильник із DEFAULT: наявні картки лишаються
-- без пароля і нічого в них не змінюється.

ALTER TABLE "Customer"
  ADD COLUMN "passwordHash"        TEXT,
  ADD COLUMN "passwordFails"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "passwordLockedUntil" TIMESTAMP(3);
