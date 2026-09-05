CREATE TABLE "TrainerHours" (
    "id" UUID NOT NULL,
    "trainerId" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "openMinute" INTEGER NOT NULL,
    "closeMinute" INTEGER NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainerHours_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TrainerHours_weekday_check" CHECK ("weekday" BETWEEN 0 AND 6),
    CONSTRAINT "TrainerHours_minutes_check" CHECK (
      ("isClosed" = true AND "openMinute" BETWEEN 0 AND 1800 AND "closeMinute" BETWEEN 0 AND 1800)
      OR
      ("isClosed" = false AND "openMinute" BETWEEN 0 AND 1799 AND "closeMinute" BETWEEN 1 AND 1800 AND "closeMinute" > "openMinute")
    )
);

CREATE UNIQUE INDEX "TrainerHours_trainerId_weekday_key" ON "TrainerHours"("trainerId", "weekday");
CREATE INDEX "TrainerHours_trainerId_idx" ON "TrainerHours"("trainerId");

ALTER TABLE "TrainerHours" ADD CONSTRAINT "TrainerHours_trainerId_fkey"
FOREIGN KEY ("trainerId") REFERENCES "Trainer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
