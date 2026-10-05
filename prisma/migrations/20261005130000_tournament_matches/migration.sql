-- Турнірна сітка: окремі таблиці замість JSON-поля.
CREATE TYPE "TournamentStatus" AS ENUM ('DRAFT', 'RUNNING', 'FINISHED');
CREATE TYPE "TournamentMatchStatus" AS ENUM ('PENDING', 'SCHEDULED', 'LIVE', 'DONE', 'WALKOVER', 'RETIRED');

ALTER TABLE "Booking"
  ADD COLUMN "tournamentStatus" "TournamentStatus",
  ADD COLUMN "tournamentFormat" TEXT,
  ADD COLUMN "thirdPlace" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "TournamentEntry" (
  "id" UUID NOT NULL,
  "bookingId" UUID NOT NULL,
  "clubId" UUID NOT NULL,
  "seatId" UUID,
  "customerId" UUID,
  "name" TEXT NOT NULL,
  "seed" INTEGER NOT NULL,
  "withdrawnAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TournamentEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TournamentMatch" (
  "id" UUID NOT NULL,
  "bookingId" UUID NOT NULL,
  "clubId" UUID NOT NULL,
  "round" INTEGER NOT NULL,
  "slot" INTEGER NOT NULL,
  "entryAId" UUID,
  "entryBId" UUID,
  "sets" JSONB NOT NULL DEFAULT '[]',
  "winnerEntryId" UUID,
  "status" "TournamentMatchStatus" NOT NULL DEFAULT 'PENDING',
  "courtId" UUID,
  "scheduledAt" TIMESTAMPTZ(3),
  "startedAt" TIMESTAMPTZ(3),
  "finishedAt" TIMESTAMPTZ(3),
  "note" TEXT,
  "version" INTEGER NOT NULL DEFAULT 0,
  "updatedBy" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TournamentMatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TournamentEntry_bookingId_seed_key" ON "TournamentEntry"("bookingId", "seed");
CREATE INDEX "TournamentEntry_clubId_idx" ON "TournamentEntry"("clubId");
CREATE UNIQUE INDEX "TournamentMatch_bookingId_round_slot_key" ON "TournamentMatch"("bookingId", "round", "slot");
CREATE INDEX "TournamentMatch_clubId_idx" ON "TournamentMatch"("clubId");

ALTER TABLE "TournamentEntry" ADD CONSTRAINT "TournamentEntry_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TournamentEntry" ADD CONSTRAINT "TournamentEntry_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "BookingSeat"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TournamentEntry" ADD CONSTRAINT "TournamentEntry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TournamentMatch" ADD CONSTRAINT "TournamentMatch_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TournamentMatch" ADD CONSTRAINT "TournamentMatch_entryAId_fkey" FOREIGN KEY ("entryAId") REFERENCES "TournamentEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TournamentMatch" ADD CONSTRAINT "TournamentMatch_entryBId_fkey" FOREIGN KEY ("entryBId") REFERENCES "TournamentEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TournamentMatch" ADD CONSTRAINT "TournamentMatch_winnerEntryId_fkey" FOREIGN KEY ("winnerEntryId") REFERENCES "TournamentEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TournamentMatch" ADD CONSTRAINT "TournamentMatch_courtId_fkey" FOREIGN KEY ("courtId") REFERENCES "Court"("id") ON DELETE SET NULL ON UPDATE CASCADE;
