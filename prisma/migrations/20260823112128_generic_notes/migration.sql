/*
  Warnings:

  - You are about to drop the `TrainerNote` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "NoteSubject" AS ENUM ('TRAINER', 'COURT');

-- DropForeignKey
ALTER TABLE "public"."TrainerNote" DROP CONSTRAINT "TrainerNote_authorId_fkey";

-- DropForeignKey
ALTER TABLE "public"."TrainerNote" DROP CONSTRAINT "TrainerNote_trainerId_fkey";

-- DropTable
DROP TABLE "public"."TrainerNote";

-- CreateTable
CREATE TABLE "Note" (
    "id" UUID NOT NULL,
    "subject" "NoteSubject" NOT NULL,
    "trainerId" UUID,
    "courtId" UUID,
    "text" TEXT NOT NULL,
    "rating" INTEGER,
    "authorId" UUID,
    "authorEmail" TEXT NOT NULL,
    "authorRole" "UserRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Note_subject_trainerId_createdAt_idx" ON "Note"("subject", "trainerId", "createdAt");

-- CreateIndex
CREATE INDEX "Note_subject_courtId_createdAt_idx" ON "Note"("subject", "courtId", "createdAt");

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_trainerId_fkey" FOREIGN KEY ("trainerId") REFERENCES "Trainer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_courtId_fkey" FOREIGN KEY ("courtId") REFERENCES "Court"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
