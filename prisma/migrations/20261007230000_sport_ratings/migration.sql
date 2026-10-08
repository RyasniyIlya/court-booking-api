-- Рейтинги розділені за видом спорту. Порядок: створити -> перенести -> перебудувати ключі.
-- Нічого не видаляється: Player.eloFederation / federationMatchCount / lastFederationMatchAt лишаються (дзеркало).
-- Усі наявні дані — сквош (старі ClubPlayerRating / RatingChange.sport = SQUASH / NULL).

-- 1) ELO федерації окремо для кожної пари (федерація, гравець).
CREATE TABLE "FederationPlayerRating" (
    "federationId" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "elo" INTEGER NOT NULL DEFAULT 1200,
    "matchCount" INTEGER NOT NULL DEFAULT 0,
    "lastMatchAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "FederationPlayerRating_pkey" PRIMARY KEY ("federationId","playerId"),
    CONSTRAINT "FederationPlayerRating_match_count_nonnegative" CHECK ("matchCount" >= 0)
);
CREATE INDEX "FederationPlayerRating_federationId_elo_idx" ON "FederationPlayerRating"("federationId", "elo" DESC);
CREATE INDEX "FederationPlayerRating_playerId_idx" ON "FederationPlayerRating"("playerId");
ALTER TABLE "FederationPlayerRating" ADD CONSTRAINT "FederationPlayerRating_federationId_fkey" FOREIGN KEY ("federationId") REFERENCES "Federation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FederationPlayerRating" ADD CONSTRAINT "FederationPlayerRating_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2) Перенос: гравці, що належать федерації.
INSERT INTO "FederationPlayerRating" ("federationId", "playerId", "elo", "matchCount", "lastMatchAt", "updatedAt")
SELECT p."federationId", p."id", p."eloFederation", p."federationMatchCount", p."lastFederationMatchAt", CURRENT_TIMESTAMP
FROM "Player" p
WHERE p."federationId" IS NOT NULL
ON CONFLICT ("federationId", "playerId") DO NOTHING;

-- 2b) Перенос: гравці БЕЗ federationId, що вже грали офіційні турніри (афілійовані через клуб).
--     Федерація береться з турніру, де вони отримали ELO; значення — поточні в Player.
INSERT INTO "FederationPlayerRating" ("federationId", "playerId", "elo", "matchCount", "lastMatchAt", "updatedAt")
SELECT DISTINCT ON (b."federationId", p."id")
    b."federationId", p."id", p."eloFederation", p."federationMatchCount", p."lastFederationMatchAt", CURRENT_TIMESTAMP
FROM "RatingChange" rc
JOIN "TournamentMatch" tm ON tm."id" = COALESCE(rc."matchRefId", rc."matchId")
JOIN "Booking" b ON b."id" = tm."bookingId"
JOIN "Player" p ON p."id" = rc."playerId"
WHERE rc."ratingType" = 'FEDERATION' AND b."federationId" IS NOT NULL
ORDER BY b."federationId", p."id", rc."effectiveAt" DESC
ON CONFLICT ("federationId", "playerId") DO NOTHING;

-- 3) Клубні очки по видах спорту: PK (clubId, playerId) -> (clubId, playerId, sport).
ALTER TABLE "ClubPlayerRating" ADD COLUMN "sport" "Sport" NOT NULL DEFAULT 'SQUASH';
ALTER TABLE "ClubPlayerRating" DROP CONSTRAINT "ClubPlayerRating_pkey";
ALTER TABLE "ClubPlayerRating" ADD CONSTRAINT "ClubPlayerRating_pkey" PRIMARY KEY ("clubId","playerId","sport");

-- 4) Аудит: вид спорту зміни рейтингу (NULL = старі рядки = сквош).
ALTER TABLE "RatingChange" ADD COLUMN "sport" "Sport";
