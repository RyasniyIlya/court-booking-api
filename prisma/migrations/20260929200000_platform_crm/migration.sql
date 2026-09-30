-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('NEW', 'CHECKING', 'CONTACTED', 'QUALIFIED', 'DEMO', 'PROPOSAL', 'WON', 'LOST', 'NOT_FIT');

-- CreateEnum
CREATE TYPE "CrmActivityKind" AS ENUM ('NOTE', 'CALL', 'MESSAGE', 'MEETING', 'DEMO', 'TASK', 'SYSTEM');

-- AlterTable
ALTER TABLE "Club" ADD COLUMN     "city" TEXT,
ADD COLUMN     "crmTags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "Lead" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "edrpou" TEXT,
    "city" TEXT,
    "region" TEXT,
    "address" TEXT,
    "sport" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "instagram" TEXT,
    "contactName" TEXT,
    "contactRole" TEXT,
    "courtsCount" INTEGER,
    "currentSystem" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "priority" TEXT NOT NULL DEFAULT 'B',
    "stage" "LeadStage" NOT NULL DEFAULT 'NEW',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "painConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "decisionMaker" BOOLEAN NOT NULL DEFAULT false,
    "planInterest" TEXT,
    "nextAction" TEXT,
    "nextActionAt" TIMESTAMP(3),
    "lastContactAt" TIMESTAMP(3),
    "lostReason" TEXT,
    "note" TEXT,
    "revenueYear" BIGINT,
    "marketScore" TEXT,
    "finScore" TEXT,
    "clubId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmActivity" (
    "id" UUID NOT NULL,
    "leadId" UUID,
    "clubId" UUID,
    "kind" "CrmActivityKind" NOT NULL DEFAULT 'NOTE',
    "text" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "author" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Lead_edrpou_key" ON "Lead"("edrpou");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_clubId_key" ON "Lead"("clubId");

-- CreateIndex
CREATE INDEX "Lead_stage_idx" ON "Lead"("stage");

-- CreateIndex
CREATE INDEX "Lead_nextActionAt_idx" ON "Lead"("nextActionAt");

-- CreateIndex
CREATE INDEX "Lead_city_idx" ON "Lead"("city");

-- CreateIndex
CREATE INDEX "Lead_phone_idx" ON "Lead"("phone");

-- CreateIndex
CREATE INDEX "CrmActivity_leadId_createdAt_idx" ON "CrmActivity"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "CrmActivity_clubId_createdAt_idx" ON "CrmActivity"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "CrmActivity_kind_doneAt_dueAt_idx" ON "CrmActivity"("kind", "doneAt", "dueAt");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

