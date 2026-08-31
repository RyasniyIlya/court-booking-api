-- Заявки «забув пароль» з Telegram.
--
-- Оператор не може прочитати пароль клубу (bcrypt), тому єдиний шлях
-- відновлення — задати новий. Таблиця робить із цього процедуру: заявка
-- приходить з бота, оператор звіряє її з тим, хто телефонує, і закриває.
-- Запис лишається як слід дії, що відкриває чужий кабінет.

CREATE TYPE "ResetStatus" AS ENUM ('PENDING', 'DONE', 'REJECTED');

CREATE TABLE "PasswordReset" (
    "id"         UUID          NOT NULL,
    "clubId"     UUID          NOT NULL,
    "userId"     UUID          NOT NULL,
    "email"      TEXT          NOT NULL,
    "tgChatId"   TEXT,
    "tgName"     TEXT,
    "status"     "ResetStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt"  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("id")
);

-- Панель відкривається списком нових заявок — індекс саме під цей запит.
CREATE INDEX "PasswordReset_status_createdAt_idx" ON "PasswordReset"("status", "createdAt");
CREATE INDEX "PasswordReset_clubId_idx" ON "PasswordReset"("clubId");

-- Cascade: видалений клуб чи акаунт не має лишати висячих заявок.
ALTER TABLE "PasswordReset" ADD CONSTRAINT "PasswordReset_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PasswordReset" ADD CONSTRAINT "PasswordReset_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
