-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "pinLookupHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Customer_clubId_pinLookupHash_key" ON "Customer"("clubId", "pinLookupHash");
