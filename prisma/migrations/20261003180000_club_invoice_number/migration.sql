-- AlterTable
ALTER TABLE "ClubInvoice" ADD COLUMN     "number" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ClubInvoice_number_key" ON "ClubInvoice"("number");
