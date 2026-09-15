CREATE TABLE "TelegramReceipt" (
  "id" INTEGER PRIMARY KEY,
  "leaseUntil" TIMESTAMP(3) NOT NULL,
  "doneAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "Booking" ADD COLUMN "playerReminderLeaseUntil" TIMESTAMP(3);
ALTER TABLE "BookingSeat" ADD COLUMN "playerReminderLeaseUntil" TIMESTAMP(3);
