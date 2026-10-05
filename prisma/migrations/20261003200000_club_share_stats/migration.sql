-- Згода клубу на показ партнеру агрегатів завантаженості кортів
ALTER TABLE "Club" ADD COLUMN "shareStatsWithPartner" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Club" ADD COLUMN "shareStatsChangedAt" TIMESTAMP(3);
