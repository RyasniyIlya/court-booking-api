CREATE TYPE "TrainerScheduleExceptionKind" AS ENUM ('WORKING', 'UNAVAILABLE', 'DAY_OFF', 'VACATION');

ALTER TABLE "TrainerScheduleException"
ADD COLUMN "kind" "TrainerScheduleExceptionKind" NOT NULL DEFAULT 'WORKING';

UPDATE "TrainerScheduleException"
SET "kind" = 'DAY_OFF'
WHERE "isClosed" = true;
