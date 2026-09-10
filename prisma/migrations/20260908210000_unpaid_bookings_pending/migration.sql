-- A paid private booking is confirmed only after the full amount is received.
-- Normalize older rows that could be confirmed by an administrator before payment.
UPDATE "Booking" AS b
SET
  "status" = 'PENDING',
  "confirmedBy" = NULL,
  "confirmedAt" = NULL,
  "expiresAt" = NULL
WHERE b."capacity" IS NULL
  AND b."status" = 'CONFIRMED'
  AND b."priceTotal" > 0
  AND (
    COALESCE((
      SELECT SUM(CASE WHEN l."kind" = 'PAYMENT' THEN l."amount" ELSE -l."amount" END)
      FROM "BookingLedgerEntry" AS l
      WHERE l."bookingId" = b."id" AND l."seatId" IS NULL
    ), 0)
    + COALESCE((
      SELECT p."amount"
      FROM "Payment" AS p
      WHERE p."bookingId" = b."id" AND p."status" = 'PAID'
      LIMIT 1
    ), 0)
  ) < b."priceTotal";
