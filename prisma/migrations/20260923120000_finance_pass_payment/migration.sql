-- Фінанси: спосіб оплати абонемента й нові категорії витрат.
--
-- Міграція тільки додає. Старі абонементи лишаються з payMethod = NULL —
-- у касі вони й далі йдуть як «не вказано», а не вгадуються заднім числом.

ALTER TABLE "Pass" ADD COLUMN IF NOT EXISTS "payMethod" TEXT;
ALTER TABLE "Pass" ADD COLUMN IF NOT EXISTS "payAccount" TEXT NOT NULL DEFAULT '';

ALTER TABLE "Pass" DROP CONSTRAINT IF EXISTS "Pass_payMethod_check";
ALTER TABLE "Pass" ADD CONSTRAINT "Pass_payMethod_check"
  CHECK ("payMethod" IS NULL OR "payMethod" IN ('CASH', 'CARD', 'TRANSFER', 'ONLINE'));

ALTER TYPE "ExpenseCategory" ADD VALUE IF NOT EXISTS 'MARKETING';
ALTER TYPE "ExpenseCategory" ADD VALUE IF NOT EXISTS 'EQUIPMENT';
ALTER TYPE "ExpenseCategory" ADD VALUE IF NOT EXISTS 'TAX';
