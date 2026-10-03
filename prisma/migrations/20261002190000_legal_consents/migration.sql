-- AlterTable
ALTER TABLE "Club" ADD COLUMN     "email" TEXT,
ADD COLUMN     "extraRules" TEXT,
ADD COLUMN     "lateCancelFeePercent" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "legalAddress" TEXT,
ADD COLUMN     "legalCode" TEXT,
ADD COLUMN     "legalName" TEXT,
ADD COLUMN     "offerAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "offerVersion" TEXT,
ADD COLUMN     "refundDays" INTEGER NOT NULL DEFAULT 7;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "marketingConsentAt" TIMESTAMP(3),
ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "termsVersion" TEXT;
