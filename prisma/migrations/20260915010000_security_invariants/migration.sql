-- Fails without changing bookings if trainer conflicts already exist.
ALTER TABLE "Booking" ADD CONSTRAINT trainer_no_overlap
  EXCLUDE USING gist (
    "trainerId" WITH =,
    tstzrange("startTime", "endTime", '[)') WITH &&
  ) WHERE ("trainerId" IS NOT NULL AND status IN ('PENDING', 'CONFIRMED'));

-- Keep notification groups, revoke group-based staff identities.
UPDATE "User" SET "tgChatId" = NULL, "tgLinkCode" = NULL, "tgLinkUntil" = NULL
WHERE "tgChatId" LIKE '-%';
