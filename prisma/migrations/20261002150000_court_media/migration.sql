-- Фото й відео корту для віджета. Лише адитивно: нова nullable-колонка
-- і нова таблиця, наявні рядки не змінюються.
ALTER TABLE "Court" ADD COLUMN "videoUrl" TEXT;

CREATE TABLE "CourtPhoto" (
    "id" UUID NOT NULL,
    "courtId" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "data" BYTEA NOT NULL,
    "mime" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourtPhoto_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CourtPhoto_courtId_sortOrder_idx" ON "CourtPhoto"("courtId", "sortOrder");

ALTER TABLE "CourtPhoto" ADD CONSTRAINT "CourtPhoto_courtId_fkey" FOREIGN KEY ("courtId") REFERENCES "Court"("id") ON DELETE CASCADE ON UPDATE CASCADE;
