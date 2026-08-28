-- Особистий Telegram співробітника.
--
-- Окремо від Club.telegramChatId: той — спільна група клубу. Тут особистий
-- чат людини: власнику йдуть цифри дня, тренеру — тільки його заняття.

ALTER TABLE "User" ADD COLUMN "tgChatId"    TEXT;
ALTER TABLE "User" ADD COLUMN "tgLinkCode"  TEXT;
ALTER TABLE "User" ADD COLUMN "tgLinkUntil" TIMESTAMP(3);

-- unique, а не звичайний індекс: один чат = одна людина. Інакше двоє
-- співробітників одного клубу отримували б повідомлення одне одного.
CREATE UNIQUE INDEX "User_tgChatId_key"   ON "User"("tgChatId");
CREATE UNIQUE INDEX "User_tgLinkCode_key" ON "User"("tgLinkCode");
