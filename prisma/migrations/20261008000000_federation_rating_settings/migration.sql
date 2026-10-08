-- Additive: налаштування ELO федерації (NULL = типові) + журнал змін налаштувань.
ALTER TABLE "Federation" ADD COLUMN "ratingSettings" JSONB;

CREATE TABLE "FederationSettingsLog" (
    "id" UUID NOT NULL,
    "federationId" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actorEmail" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FederationSettingsLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FederationSettingsLog_federationId_at_idx" ON "FederationSettingsLog"("federationId", "at");
ALTER TABLE "FederationSettingsLog" ADD CONSTRAINT "FederationSettingsLog_federationId_fkey" FOREIGN KEY ("federationId") REFERENCES "Federation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
