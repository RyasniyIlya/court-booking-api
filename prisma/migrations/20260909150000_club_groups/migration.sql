CREATE TABLE "ClubGroup" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubGroup_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Club" ADD COLUMN "groupId" UUID;

CREATE INDEX "Club_groupId_idx" ON "Club"("groupId");

ALTER TABLE "Club" ADD CONSTRAINT "Club_groupId_fkey"
FOREIGN KEY ("groupId") REFERENCES "ClubGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
