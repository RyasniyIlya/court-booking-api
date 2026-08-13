CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Booking"
  ADD CONSTRAINT booking_no_overlap
  EXCLUDE USING gist (
    "courtId" WITH =,
    tstzrange("startTime", "endTime", '[)') WITH &&
  )
  WHERE (status <> 'CANCELLED');

ALTER TABLE "Block"
  ADD CONSTRAINT block_no_overlap
  EXCLUDE USING gist (
    "courtId" WITH =,
    tstzrange("startTime", "endTime", '[)') WITH &&
  );

ALTER TABLE "Booking" ADD CONSTRAINT booking_time_order CHECK ("endTime" > "startTime");
ALTER TABLE "Block"   ADD CONSTRAINT block_time_order   CHECK ("endTime" > "startTime");
