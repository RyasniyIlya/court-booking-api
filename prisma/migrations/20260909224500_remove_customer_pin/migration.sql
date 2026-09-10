DROP INDEX IF EXISTS "Customer_clubId_pinLookupHash_key";

ALTER TABLE "Customer"
  DROP COLUMN IF EXISTS "pinHash",
  DROP COLUMN IF EXISTS "pinFails",
  DROP COLUMN IF EXISTS "pinLockedUntil",
  DROP COLUMN IF EXISTS "pinLookupHash";
