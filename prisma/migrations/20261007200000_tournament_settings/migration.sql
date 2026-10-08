-- Additive: налаштування турніру (teamSize, setsToWin, pointsToWin, goldenPoint). NULL = старий турнір, стара логіка.
ALTER TABLE "Booking" ADD COLUMN "tournamentSettings" JSONB;
