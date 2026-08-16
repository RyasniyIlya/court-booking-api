-- EXPIRED має звільняти слот.
--
-- Старий констрейнт рахував зайнятим усе, крім CANCELLED. З появою передоплати
-- зʼявився статус EXPIRED (не оплатив за 15 хвилин) — такі броні мають
-- звільняти час, інакше кожна покинута оплата назавжди зʼїдає слот.
--
-- Констрейнт не виражається у schema.prisma, тому міграція написана руками —
-- так само, як 20260813090000_no_double_booking.

ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS booking_no_overlap;

ALTER TABLE "Booking"
  ADD CONSTRAINT booking_no_overlap
  EXCLUDE USING gist (
    "courtId" WITH =,
    tstzrange("startTime", "endTime", '[)') WITH &&
  )
  WHERE (status NOT IN ('CANCELLED', 'EXPIRED'));
