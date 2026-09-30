-- AlterTable
-- listPrice: nullable навмисно — броні до цієї міграції не мають чим
-- заповнитись, історію заднім числом не відновити (див. коментар у schema.prisma).
-- promoIds: NOT NULL DEFAULT ARRAY[]::UUID[], як і всі інші масиви ідентифікаторів
-- у схемі (напр. Promo.courtIds) — порожній масив, а не NULL, для нових і старих рядків.
ALTER TABLE "Booking"
ADD COLUMN "listPrice" INTEGER,
ADD COLUMN "promoIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
