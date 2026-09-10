-- Older manual receipts did not change the booking status. Bring fully paid
-- private bookings to the same state as new manual and online payments.
UPDATE "Booking" AS b
SET
  "status" = 'CONFIRMED',
  "expiresAt" = NULL,
  "confirmedBy" = COALESCE((
    SELECT l."actorEmail"
    FROM "BookingLedgerEntry" AS l
    WHERE l."bookingId" = b."id" AND l."seatId" IS NULL AND l."kind" = 'PAYMENT'
    ORDER BY l."createdAt" DESC, l."id" DESC
    LIMIT 1
  ), 'Платіжний провайдер'),
  "confirmedAt" = COALESCE((
    SELECT l."createdAt"
    FROM "BookingLedgerEntry" AS l
    WHERE l."bookingId" = b."id" AND l."seatId" IS NULL AND l."kind" = 'PAYMENT'
    ORDER BY l."createdAt" DESC, l."id" DESC
    LIMIT 1
  ), (
    SELECT p."paidAt"
    FROM "Payment" AS p
    WHERE p."bookingId" = b."id" AND p."status" = 'PAID'
    LIMIT 1
  ), NOW())
WHERE b."capacity" IS NULL
  AND b."status" = 'PENDING'
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
  ) >= b."priceTotal";
