-- Клубний інвентар: ракетки, мʼячі, сітки, столи.
--
-- Фото лежать байтами в цій же таблиці, як і логотип клубу: файлова
-- система на хостингу ефемерна, після деплою картинки зникли б.
-- Читати їх окремим запитом обовʼязково — інакше список з двадцяти
-- позицій тягнув би з бази кілька мегабайт на кожне відкриття вкладки.

CREATE TABLE "InventoryItem" (
  "id"             UUID NOT NULL,
  "clubId"         UUID NOT NULL,
  "name"           TEXT NOT NULL,
  "category"       TEXT,
  "quantity"       INTEGER NOT NULL DEFAULT 0,
  "unit"           TEXT,
  "note"           TEXT,
  "photoData"      BYTEA,
  "photoMime"      TEXT,
  "photoUpdatedAt" TIMESTAMP(3),
  "sortOrder"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InventoryItem_clubId_sortOrder_idx" ON "InventoryItem"("clubId", "sortOrder");

ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_clubId_fkey"
FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Відʼємної кількості ракеток не буває. Стеля — щоб описка в полі не
-- перетворила комору на мільйон мʼячів і не зламала підсумки на екрані.
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_quantity_range"
CHECK ("quantity" >= 0 AND "quantity" <= 1000000);
