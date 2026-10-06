-- CreateEnum
CREATE TYPE "TournamentScope" AS ENUM ('CLUB', 'INTERCLUB', 'FEDERATION');

-- CreateEnum
CREATE TYPE "RatingLevelSource" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "RatingType" AS ENUM ('CLUB', 'FEDERATION');

-- CreateEnum
CREATE TYPE "RatingChangeKind" AS ENUM ('MATCH', 'MANUAL', 'IMPORT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "FederationPartnershipStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REVOKED');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "federationCode" TEXT,
ADD COLUMN     "federationId" UUID,
ADD COLUMN     "tournamentScope" "TournamentScope" NOT NULL DEFAULT 'CLUB';

-- AlterTable
ALTER TABLE "TournamentEntry" ADD COLUMN     "playerId" UUID;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "playerId" UUID;

-- CreateTable
CREATE TABLE "Player" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phoneVerifiedAt" TIMESTAMPTZ(3),
    "eloFederation" INTEGER NOT NULL DEFAULT 1200,
    "federationMatchCount" INTEGER NOT NULL DEFAULT 0,
    "lastFederationMatchAt" TIMESTAMPTZ(3),
    "levelSource" "RatingLevelSource" NOT NULL DEFAULT 'AUTO',
    "manualLevel" TEXT,
    "federationId" UUID,
    "federationPlayerCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubPlayerRating" (
    "clubId" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "eloClub" INTEGER NOT NULL DEFAULT 1200,
    "matchCount" INTEGER NOT NULL DEFAULT 0,
    "lastMatchAt" TIMESTAMPTZ(3),
    "levelSource" "RatingLevelSource" NOT NULL DEFAULT 'AUTO',
    "manualLevel" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ClubPlayerRating_pkey" PRIMARY KEY ("clubId","playerId")
);

-- CreateTable
CREATE TABLE "Federation" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "logoUrl" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Federation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubFederation" (
    "clubId" UUID NOT NULL,
    "federationId" UUID NOT NULL,
    "status" "FederationPartnershipStatus" NOT NULL DEFAULT 'PENDING',
    "confirmedAt" TIMESTAMPTZ(3),
    "confirmedBy" TEXT,

    CONSTRAINT "ClubFederation_pkey" PRIMARY KEY ("clubId","federationId")
);

-- CreateTable
CREATE TABLE "TournamentClub" (
    "bookingId" UUID NOT NULL,
    "clubId" UUID NOT NULL,

    CONSTRAINT "TournamentClub_pkey" PRIMARY KEY ("bookingId","clubId")
);

-- CreateTable
CREATE TABLE "RatingChange" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "matchId" UUID,
    "matchRefId" UUID,
    "clubId" UUID,
    "ratingType" "RatingType" NOT NULL,
    "kind" "RatingChangeKind" NOT NULL,
    "before" INTEGER NOT NULL,
    "after" INTEGER NOT NULL,
    "matchCountBefore" INTEGER NOT NULL DEFAULT 0,
    "matchCountAfter" INTEGER NOT NULL DEFAULT 0,
    "lastMatchAtBefore" TIMESTAMPTZ(3),
    "lastMatchAtAfter" TIMESTAMPTZ(3),
    "matchVersion" INTEGER,
    "calculationVersion" TEXT,
    "changedBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "reversesId" UUID,
    "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RatingChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Player_phone_key" ON "Player"("phone");

-- CreateIndex
CREATE INDEX "Player_eloFederation_id_idx" ON "Player"("eloFederation", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Player_federationId_federationPlayerCode_key" ON "Player"("federationId", "federationPlayerCode");

-- CreateIndex
CREATE INDEX "ClubPlayerRating_clubId_eloClub_playerId_idx" ON "ClubPlayerRating"("clubId", "eloClub", "playerId");

-- CreateIndex
CREATE INDEX "ClubPlayerRating_playerId_idx" ON "ClubPlayerRating"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "Federation_code_key" ON "Federation"("code");

-- CreateIndex
CREATE INDEX "ClubFederation_federationId_status_idx" ON "ClubFederation"("federationId", "status");

-- CreateIndex
CREATE INDEX "TournamentClub_clubId_idx" ON "TournamentClub"("clubId");

-- CreateIndex
CREATE UNIQUE INDEX "RatingChange_idempotencyKey_key" ON "RatingChange"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "RatingChange_reversesId_key" ON "RatingChange"("reversesId");

-- CreateIndex
CREATE INDEX "RatingChange_playerId_ratingType_effectiveAt_id_idx" ON "RatingChange"("playerId", "ratingType", "effectiveAt", "id");

-- CreateIndex
CREATE INDEX "RatingChange_clubId_playerId_effectiveAt_idx" ON "RatingChange"("clubId", "playerId", "effectiveAt");

-- CreateIndex
CREATE INDEX "RatingChange_matchId_matchVersion_idx" ON "RatingChange"("matchId", "matchVersion");

-- CreateIndex
CREATE INDEX "TournamentEntry_playerId_idx" ON "TournamentEntry"("playerId");

-- CreateIndex
CREATE INDEX "TournamentMatch_entryAId_idx" ON "TournamentMatch"("entryAId");

-- CreateIndex
CREATE INDEX "TournamentMatch_entryBId_idx" ON "TournamentMatch"("entryBId");

-- CreateIndex
CREATE INDEX "TournamentMatch_winnerEntryId_idx" ON "TournamentMatch"("winnerEntryId");

-- CreateIndex
CREATE INDEX "Customer_playerId_idx" ON "Customer"("playerId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_federationId_fkey" FOREIGN KEY ("federationId") REFERENCES "Federation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentEntry" ADD CONSTRAINT "TournamentEntry_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_federationId_fkey" FOREIGN KEY ("federationId") REFERENCES "Federation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubPlayerRating" ADD CONSTRAINT "ClubPlayerRating_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubPlayerRating" ADD CONSTRAINT "ClubPlayerRating_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubFederation" ADD CONSTRAINT "ClubFederation_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubFederation" ADD CONSTRAINT "ClubFederation_federationId_fkey" FOREIGN KEY ("federationId") REFERENCES "Federation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentClub" ADD CONSTRAINT "TournamentClub_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentClub" ADD CONSTRAINT "TournamentClub_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatingChange" ADD CONSTRAINT "RatingChange_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatingChange" ADD CONSTRAINT "RatingChange_matchRefId_fkey" FOREIGN KEY ("matchRefId") REFERENCES "TournamentMatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatingChange" ADD CONSTRAINT "RatingChange_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatingChange" ADD CONSTRAINT "RatingChange_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "RatingChange"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Booking_federationId_tournamentScope_startTime_idx" ON "Booking"("federationId", "tournamentScope", "startTime");
CREATE UNIQUE INDEX "Booking_federationId_federationCode_key" ON "Booking"("federationId", "federationCode");

ALTER TABLE "Player" ADD CONSTRAINT "Player_match_count_nonnegative" CHECK ("federationMatchCount" >= 0);
ALTER TABLE "ClubPlayerRating" ADD CONSTRAINT "ClubPlayerRating_match_count_nonnegative" CHECK ("matchCount" >= 0);
ALTER TABLE "RatingChange" ADD CONSTRAINT "RatingChange_scope" CHECK (
  ("ratingType" = 'CLUB' AND "clubId" IS NOT NULL) OR
  ("ratingType" = 'FEDERATION' AND "clubId" IS NULL)
);

-- Preserve audit entries; corrections are new events linked by reversesId.
CREATE FUNCTION reject_rating_change_mutation() RETURNS trigger AS $$
BEGIN
  -- Club retention can remove a match without rewriting the rating event.
  IF TG_OP = 'UPDATE' THEN
    IF OLD."matchRefId" IS NOT NULL AND NEW."matchRefId" IS NULL
       AND (to_jsonb(OLD) - 'matchRefId') = (to_jsonb(NEW) - 'matchRefId') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'RatingChange is append-only; append a reversal instead';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER rating_change_append_only BEFORE UPDATE OR DELETE ON "RatingChange"
FOR EACH ROW EXECUTE FUNCTION reject_rating_change_mutation();

ALTER TABLE "RatingChange" ADD CONSTRAINT "RatingChange_match_reference" CHECK (
  "matchRefId" IS NULL OR ("matchId" IS NOT NULL AND "matchRefId" = "matchId")
);
CREATE INDEX "RatingChange_matchRefId_idx" ON "RatingChange"("matchRefId");
