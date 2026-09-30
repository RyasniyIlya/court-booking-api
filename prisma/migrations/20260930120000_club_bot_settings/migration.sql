-- AlterTable
ALTER TABLE "Club" ADD COLUMN     "botSettings" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "tgMarketingAt" TIMESTAMP(3),
ADD COLUMN     "tgMarketingAskedAt" TIMESTAMP(3),
ADD COLUMN     "tgLastActiveAt" TIMESTAMP(3),
ADD COLUMN     "winbackCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "winbackLastAt" TIMESTAMP(3);
