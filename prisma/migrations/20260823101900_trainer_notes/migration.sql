-- CreateTable
CREATE TABLE "TrainerNote" (
    "id" UUID NOT NULL,
    "trainerId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "authorId" UUID,
    "authorEmail" TEXT NOT NULL,
    "authorRole" "UserRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainerNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrainerNote_trainerId_createdAt_idx" ON "TrainerNote"("trainerId", "createdAt");

-- AddForeignKey
ALTER TABLE "TrainerNote" ADD CONSTRAINT "TrainerNote_trainerId_fkey" FOREIGN KEY ("trainerId") REFERENCES "Trainer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainerNote" ADD CONSTRAINT "TrainerNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
