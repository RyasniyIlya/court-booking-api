-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "pinFails" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pinHash" TEXT,
ADD COLUMN     "pinLockedUntil" TIMESTAMP(3);
