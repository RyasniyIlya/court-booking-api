-- One account has one password. Keep the existing account password and
-- remove the additional moderator/owner PIN credentials and access levels.

ALTER TABLE "User"
  DROP COLUMN "pinModerHash",
  DROP COLUMN "pinOwnerHash";
