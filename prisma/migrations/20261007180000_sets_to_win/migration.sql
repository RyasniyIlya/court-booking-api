-- Additive: формат матчу «до N виграних сетів». Старі турніри (NULL) рахуються як раніше — більше виграних сетів.
ALTER TABLE "Club" ADD COLUMN "defaultSetsToWin" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "Booking" ADD COLUMN "tournamentSetsToWin" INTEGER;
