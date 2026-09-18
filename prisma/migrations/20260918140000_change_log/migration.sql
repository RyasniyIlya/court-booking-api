-- Журнал змін: хто, коли і що саме переписав у броні чи турнірі.
--
-- До нього історія броні складалась тільки з подій, у яких є власна мітка
-- часу (створення, оплати, скасування). Усе, що просто перезаписує колонку
-- — тренер, замітка, назва турніру, ціна місця, перенесення — не лишало по
-- собі нічого. Нова таблиця, нічого наявного не чіпає.

-- CreateTable
CREATE TABLE "ChangeLog" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actorId" UUID,
    "actorEmail" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChangeLog_clubId_entity_entityId_at_idx" ON "ChangeLog"("clubId", "entity", "entityId", "at");
CREATE INDEX "ChangeLog_clubId_at_idx" ON "ChangeLog"("clubId", "at");

-- AddForeignKey
-- Тільки на клуб. FK на саму бронь немає навмисно: журнал має пережити
-- видалення того, про що він розповідає.
ALTER TABLE "ChangeLog" ADD CONSTRAINT "ChangeLog_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
