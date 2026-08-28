-- План обслуговування: каталог, який веде оператор платформи.
--
-- Клуб свій план НЕ обирає — призначає оператор вручну після оплати.
-- Тому жодних дефолтів на Club.planId: наявні клуби лишаються з NULL, і
-- NULL свідомо означає "без обмежень" (див. src/lib/plans.ts). Поставити
-- тут DEFAULT на базовий план означало б мовчки урізати всіх, хто вже
-- працює, рівно в мить деплою.

CREATE TABLE "Plan" (
    "id"            UUID NOT NULL,
    "code"          TEXT NOT NULL,
    "name"          TEXT NOT NULL,
    "description"   TEXT,
    "price"         INTEGER NOT NULL,
    "period"        "BillingPeriod" NOT NULL DEFAULT 'MONTH',
    "tier"          INTEGER NOT NULL DEFAULT 1,
    "featTrainers"  BOOLEAN NOT NULL DEFAULT false,
    "featGroups"    BOOLEAN NOT NULL DEFAULT false,
    "featAnalytics" BOOLEAN NOT NULL DEFAULT false,
    "isActive"      BOOLEAN NOT NULL DEFAULT true,
    "sortOrder"     INTEGER NOT NULL DEFAULT 0,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");
CREATE INDEX "Plan_isActive_sortOrder_idx" ON "Plan"("isActive", "sortOrder");

ALTER TABLE "Club" ADD COLUMN "planId" UUID;
ALTER TABLE "Club" ADD COLUMN "planPrice" INTEGER;

-- ON DELETE SET NULL, а не CASCADE: видалення плану з каталогу не має
-- зносити клуб. Клуб просто лишається без плану — тобто без обмежень.
ALTER TABLE "Club"
    ADD CONSTRAINT "Club_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "Plan"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
