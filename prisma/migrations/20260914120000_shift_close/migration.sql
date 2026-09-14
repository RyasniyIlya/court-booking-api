-- Закриття зміни: звірка каси ресепшену з журналом розрахунків.
-- Нова таблиця, наявні дані не змінюються.

CREATE TABLE "ShiftClose" (
    "id"           UUID NOT NULL,
    "clubId"       UUID NOT NULL,
    "requestId"    UUID NOT NULL,
    "openedAt"     TIMESTAMPTZ(3) NOT NULL,
    "closedAt"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedCash" INTEGER NOT NULL,
    "countedCash"  INTEGER NOT NULL,
    "expectedCard" INTEGER NOT NULL,
    "countedCard"  INTEGER NOT NULL,
    "transferNet"  INTEGER NOT NULL DEFAULT 0,
    "bonusNet"     INTEGER NOT NULL DEFAULT 0,
    "entriesCount" INTEGER NOT NULL DEFAULT 0,
    "note"         TEXT NOT NULL DEFAULT '',
    "actorId"      UUID NOT NULL,
    "actorEmail"   TEXT NOT NULL,
    "actorName"    TEXT,
    "actorRole"    TEXT NOT NULL,

    CONSTRAINT "ShiftClose_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ShiftClose_counted_nonnegative" CHECK ("countedCash" >= 0 AND "countedCard" >= 0)
);

CREATE UNIQUE INDEX "ShiftClose_clubId_requestId_key" ON "ShiftClose"("clubId", "requestId");
CREATE INDEX "ShiftClose_clubId_closedAt_idx" ON "ShiftClose"("clubId", "closedAt");

ALTER TABLE "ShiftClose" ADD CONSTRAINT "ShiftClose_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
