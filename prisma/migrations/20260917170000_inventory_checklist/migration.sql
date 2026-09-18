-- Чек-лист інвентарю при броні: що повертають, а що витрачають, і місце під
-- заставу/штраф. Нічого наявного не переписує — лише нові колонки з
-- дефолтами, тож накат на живій базі безпечний.

-- Ракетку й чохол повертають, воду й гриптейп — ні. Дефолт true, бо
-- напрокат здають переважно поворотні речі; витратні вмикає адміністратор.
ALTER TABLE "InventoryItem" ADD COLUMN "returnable" BOOLEAN NOT NULL DEFAULT true;

-- Знімок на рядку, як itemName і unitPrice: клуб може завтра перевести
-- позицію у витратні, а те, що вже видали під повернення, повертати треба.
ALTER TABLE "BookingRental" ADD COLUMN "returnable" BOOLEAN NOT NULL DEFAULT true;

-- Застава/штраф: заготовка. Заповнює адміністратор руками, автоматичного
-- розрахунку, утримань і сповіщень на цьому етапі немає.
ALTER TABLE "BookingRental" ADD COLUMN "depositAmount" INTEGER;
ALTER TABLE "BookingRental" ADD COLUMN "depositReason" TEXT;

-- Гроші не бувають відʼємними; нуль допустимий («записали, але пробачили»).
ALTER TABLE "BookingRental"
  ADD CONSTRAINT booking_rental_deposit_non_negative
  CHECK ("depositAmount" IS NULL OR "depositAmount" >= 0);

-- Сума без причини й причина без суми однаково нечитабельні в касі за
-- півроку. Або обидва поля, або жодного.
ALTER TABLE "BookingRental"
  ADD CONSTRAINT booking_rental_deposit_paired
  CHECK (("depositAmount" IS NULL) = ("depositReason" IS NULL));

-- «На руках у клієнта»: видана поворотна річ, яку ще не прийняли. Таких
-- рядків одиниці проти всієї історії прокату, і саме їх питає кожен
-- розрахунок вільного залишку — частковий індекс замість повного.
CREATE INDEX "BookingRental_on_hand_idx"
    ON "BookingRental" ("clubId", "itemId")
 WHERE "status" = 'ISSUED'::"RentalStatus" AND "returnable";
