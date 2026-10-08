-- Additive: legacy ELO columns and existing customer data are preserved.
ALTER TABLE "Club" ADD COLUMN "clubRatingRules" JSONB NOT NULL DEFAULT '{"win":10,"first":30,"second":20,"third":10}';
ALTER TABLE "Booking" ADD COLUMN "ratingsAppliedAt" TIMESTAMPTZ(3),
  ADD COLUMN "tournamentGender" TEXT, ADD COLUMN "tournamentCategory" TEXT,
  ADD COLUMN "tournamentAgeCategory" TEXT, ADD COLUMN "tournamentDescription" TEXT;
ALTER TABLE "Player" ADD COLUMN "avatarUrl" TEXT, ADD COLUMN "bio" TEXT,
  ADD COLUMN "gender" TEXT, ADD COLUMN "birthDate" DATE, ADD COLUMN "ageCategory" TEXT,
  ADD COLUMN "skillLevel" TEXT, ADD COLUMN "publicProfile" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ClubPlayerRating" ADD COLUMN "points" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "wins" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "tournamentWins" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "group" TEXT, ADD COLUMN "category" TEXT, ADD COLUMN "title" TEXT,
  ADD COLUMN "status" TEXT, ADD COLUMN "achievements" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX "ClubPlayerRating_clubId_points_playerId_idx" ON "ClubPlayerRating"("clubId", "points", "playerId");
CREATE TABLE "FederationAccount" (
  "id" UUID PRIMARY KEY, "federationId" UUID NOT NULL REFERENCES "Federation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "email" TEXT NOT NULL UNIQUE, "name" TEXT NOT NULL, "passwordHash" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true, "loginFails" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMPTZ(3), "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "FederationAccount_federationId_idx" ON "FederationAccount"("federationId");
ALTER TABLE "ClubPlayerRating" ADD CONSTRAINT "club_rating_nonnegative" CHECK (points >= 0 AND wins >= 0 AND "tournamentWins" >= 0);
ALTER TABLE "Booking" ADD CONSTRAINT "federation_scope_requires_organizer" CHECK ("tournamentScope" <> 'FEDERATION' OR "federationId" IS NOT NULL) NOT VALID;
