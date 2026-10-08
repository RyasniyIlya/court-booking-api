-- Additive: види спорту клубів/турнірів і парний формат; старі турніри лишаються одиночними.
CREATE TYPE "Sport" AS ENUM ('PADEL', 'TENNIS', 'SQUASH');
ALTER TABLE "Club" ADD COLUMN "sports" "Sport"[] DEFAULT ARRAY[]::"Sport"[];
ALTER TABLE "Booking" ADD COLUMN "tournamentSport" "Sport",
  ADD COLUMN "tournamentTeamSize" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "TournamentEntry" ADD COLUMN "partnerPlayerId" UUID;
ALTER TABLE "TournamentEntry" ADD CONSTRAINT "TournamentEntry_partnerPlayerId_fkey"
  FOREIGN KEY ("partnerPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "TournamentEntry_partnerPlayerId_idx" ON "TournamentEntry"("partnerPlayerId");
