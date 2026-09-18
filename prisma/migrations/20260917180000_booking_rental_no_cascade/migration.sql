-- Deleting a booking must not silently erase its rental lines (issued rackets, deposits).
-- NO ACTION (not RESTRICT) so the Club cascade that removes both in one statement still works.
ALTER TABLE "BookingRental" DROP CONSTRAINT "BookingRental_bookingId_fkey";
ALTER TABLE "BookingRental" ADD CONSTRAINT "BookingRental_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
