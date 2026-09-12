-- Налаштування сповіщень: що саме приходить у чат і за скільки хвилин.
--
-- Окремі колонки, а не JSON: за цими прапорцями йде ВІДБІР отримувачів у
-- SQL (див. lib/remind.ts). У JSON така умова перетворилась би на вибірку
-- всіх користувачів клубу з фільтрацією в пам'яті.
--
-- Усі DEFAULT true, окрім жодного: людина, яка щойно підключила бота, має
-- побачити, що він працює. Вимикач стоїть в самому боті (/settings), і
-- дійти до нього дешевше, ніж здогадатись, що вмикач десь є.

ALTER TABLE "User"
  ADD COLUMN "tgNotifyTournaments" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "tgNotifyGroups"      BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "tgNotifySessions"    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "tgRemindMinutes"     INTEGER NOT NULL DEFAULT 15;
