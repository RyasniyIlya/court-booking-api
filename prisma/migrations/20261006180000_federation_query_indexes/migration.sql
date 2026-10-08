-- CreateIndex
CREATE INDEX "Player_federationId_eloFederation_id_idx" ON "Player"("federationId", "eloFederation", "id");

-- CreateIndex
CREATE INDEX "Customer_clubId_playerId_idx" ON "Customer"("clubId", "playerId");
