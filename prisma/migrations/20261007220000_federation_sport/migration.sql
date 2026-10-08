-- Additive: федерація прив'язана до одного виду спорту. Усі наявні федерації — сквош (DEFAULT).
ALTER TABLE "Federation" ADD COLUMN "sport" "Sport" NOT NULL DEFAULT 'SQUASH';
