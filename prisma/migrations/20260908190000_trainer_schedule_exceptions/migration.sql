CREATE TABLE "TrainerScheduleException" (
  "id" UUID NOT NULL,
  "trainerId" UUID NOT NULL,
  "date" DATE NOT NULL,
  "isClosed" BOOLEAN NOT NULL DEFAULT false,
  "intervals" JSONB NOT NULL DEFAULT '[]',
  "note" TEXT,
  "updatedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TrainerScheduleException_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TrainerScheduleException_trainerId_date_key" ON "TrainerScheduleException"("trainerId", "date");
CREATE INDEX "TrainerScheduleException_trainerId_date_idx" ON "TrainerScheduleException"("trainerId", "date");
ALTER TABLE "TrainerScheduleException" ADD CONSTRAINT "TrainerScheduleException_trainerId_fkey"
FOREIGN KEY ("trainerId") REFERENCES "Trainer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
