-- Additive: добові ліміти ІІ в базі (замість памʼяті процесу) і короткий контекст розмови в Telegram.
CREATE TABLE "AiUsage" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AiUsage_clubId_scope_day_key" ON "AiUsage"("clubId", "scope", "day");
CREATE INDEX "AiUsage_day_idx" ON "AiUsage"("day");
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AiChatTurn" (
    "id" UUID NOT NULL,
    "chatId" TEXT NOT NULL,
    "clubId" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiChatTurn_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiChatTurn_chatId_clubId_mode_createdAt_idx" ON "AiChatTurn"("chatId", "clubId", "mode", "createdAt");
CREATE INDEX "AiChatTurn_createdAt_idx" ON "AiChatTurn"("createdAt");
ALTER TABLE "AiChatTurn" ADD CONSTRAINT "AiChatTurn_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
