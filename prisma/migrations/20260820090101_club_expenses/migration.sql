-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('SALARY', 'RENT', 'BANK_FEE', 'UTILITIES', 'OTHER');

-- CreateTable
CREATE TABLE "ClubExpense" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "month" DATE NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "label" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubExpense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClubExpense_clubId_month_idx" ON "ClubExpense"("clubId", "month");

-- AddForeignKey
ALTER TABLE "ClubExpense" ADD CONSTRAINT "ClubExpense_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
