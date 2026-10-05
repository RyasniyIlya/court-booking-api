-- CreateEnum
CREATE TYPE "SellerKind" AS ENUM ('FOP', 'TOV', 'INDIVIDUAL');

-- CreateEnum
CREATE TYPE "PartnerKind" AS ENUM ('FOP', 'TOV');

-- CreateEnum
CREATE TYPE "PartnerContractMode" AS ENUM ('PUBLIC_OFFER', 'INDIVIDUAL');

-- CreateEnum
CREATE TYPE "PartnerActStatus" AS ENUM ('DRAFT', 'ISSUED', 'SIGNED', 'PAID', 'VOID');

-- AlterTable
ALTER TABLE "ClubInvoice" ADD COLUMN     "sellerId" UUID;

-- AlterTable
ALTER TABLE "Partner" ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "contractDate" TIMESTAMP(3),
ADD COLUMN     "contractMode" "PartnerContractMode",
ADD COLUMN     "contractNo" TEXT,
ADD COLUMN     "docsEmail" TEXT,
ADD COLUMN     "iban" TEXT,
ADD COLUMN     "kind" "PartnerKind",
ADD COLUMN     "kvedConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "legalAddress" TEXT,
ADD COLUMN     "legalCode" TEXT,
ADD COLUMN     "legalName" TEXT,
ADD COLUMN     "offerAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "offerIp" TEXT,
ADD COLUMN     "offerSnapshot" JSONB,
ADD COLUMN     "offerVersion" TEXT,
ADD COLUMN     "requisitesAt" TIMESTAMP(3),
ADD COLUMN     "signerBasis" TEXT,
ADD COLUMN     "signerName" TEXT,
ADD COLUMN     "taxInfo" TEXT,
ADD COLUMN     "vatPayer" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SellerProfile" (
    "id" UUID NOT NULL,
    "kind" "SellerKind" NOT NULL,
    "label" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "taxInfo" TEXT,
    "iban" TEXT NOT NULL,
    "bankName" TEXT,
    "address" TEXT,
    "signerName" TEXT,
    "signerBasis" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerAct" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "amount" INTEGER NOT NULL,
    "lines" JSONB NOT NULL,
    "sellerSnapshot" JSONB NOT NULL,
    "partnerSnapshot" JSONB NOT NULL,
    "status" "PartnerActStatus" NOT NULL DEFAULT 'DRAFT',
    "issuedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "payoutId" UUID,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerAct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PartnerAct_number_key" ON "PartnerAct"("number");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerAct_payoutId_key" ON "PartnerAct"("payoutId");

-- CreateIndex
CREATE INDEX "PartnerAct_status_idx" ON "PartnerAct"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerAct_partnerId_periodFrom_key" ON "PartnerAct"("partnerId", "periodFrom");

-- CreateIndex
CREATE INDEX "ClubInvoice_sellerId_idx" ON "ClubInvoice"("sellerId");

-- AddForeignKey
ALTER TABLE "ClubInvoice" ADD CONSTRAINT "ClubInvoice_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "SellerProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerAct" ADD CONSTRAINT "PartnerAct_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerAct" ADD CONSTRAINT "PartnerAct_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "PartnerPayout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

