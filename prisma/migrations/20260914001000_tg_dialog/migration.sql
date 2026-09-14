-- Покрокова реєстрація гравця в Telegram-боті: стан діалогу між повідомленнями.

CREATE TABLE "TgDialog" (
    "chatId" TEXT NOT NULL,
    "flow" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TgDialog_pkey" PRIMARY KEY ("chatId")
);
