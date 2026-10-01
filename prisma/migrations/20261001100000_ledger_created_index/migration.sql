-- Журнал каси за період читається по (клуб, дата): без індексу кожен запит
-- «Каса → Журнал операцій» скануватиме всі записи клубу. Лише адитивно.
CREATE INDEX "BookingLedgerEntry_clubId_createdAt_idx" ON "BookingLedgerEntry"("clubId", "createdAt");
