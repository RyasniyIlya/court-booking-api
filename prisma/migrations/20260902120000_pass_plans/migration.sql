-- Абонементи: вимикач на клуб і тарифи, які власник виставляє в кабінеті.

ALTER TABLE "Club" ADD COLUMN "passesEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Клуби, у яких абонементи вже видані, вмикаємо одразу. Типове false
-- задумане для тих, хто продає разові години; вимкнути заднім числом тим,
-- у кого лежать чинні залишки, означало б сховати їх від ресепшена.
UPDATE "Club" c
   SET "passesEnabled" = true
 WHERE EXISTS (SELECT 1 FROM "Pass" p WHERE p."clubId" = c."id");

CREATE TABLE "PassPlan" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PassType" NOT NULL,
    "totalSessions" INTEGER,
    "days" INTEGER NOT NULL,
    "price" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PassPlan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PassPlan_clubId_isActive_idx" ON "PassPlan"("clubId", "isActive");

ALTER TABLE "PassPlan"
  ADD CONSTRAINT "PassPlan_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
