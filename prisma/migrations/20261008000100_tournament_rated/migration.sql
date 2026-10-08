-- Additive: клубний турнір може бути «без рейтингу» (товариський). Усі наявні — рейтингові.
ALTER TABLE "Booking" ADD COLUMN "tournamentRated" BOOLEAN NOT NULL DEFAULT true;
