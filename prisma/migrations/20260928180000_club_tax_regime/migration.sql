-- CreateEnum
CREATE TYPE "TaxRegime" AS ENUM ('FOP_1', 'FOP_2', 'FOP_3', 'FOP_GENERAL', 'TOV_SINGLE_3', 'TOV_GENERAL');

-- AlterTable
ALTER TABLE "Club" ADD COLUMN     "taxFixedMonthly" INTEGER,
ADD COLUMN     "taxRegime" "TaxRegime" NOT NULL DEFAULT 'FOP_3',
ADD COLUMN     "vatPayer" BOOLEAN NOT NULL DEFAULT false;

