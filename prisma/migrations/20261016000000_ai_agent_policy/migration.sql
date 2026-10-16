-- Additive: права ІІ-менеджера (одна політика на клуб) і журнал його дій.
CREATE TYPE "AiMode" AS ENUM ('OFF', 'ASK', 'AUTO');
CREATE TYPE "AiActionStatus" AS ENUM ('PENDING', 'EXECUTED', 'REJECTED', 'FAILED', 'EXPIRED');

CREATE TABLE "AiAgentPolicy" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "readFinance" BOOLEAN NOT NULL DEFAULT true,
    "readCustomers" BOOLEAN NOT NULL DEFAULT true,
    "readStaff" BOOLEAN NOT NULL DEFAULT true,
    "reports" BOOLEAN NOT NULL DEFAULT true,
    "bookings" "AiMode" NOT NULL DEFAULT 'ASK',
    "groupSessions" "AiMode" NOT NULL DEFAULT 'ASK',
    "tournaments" "AiMode" NOT NULL DEFAULT 'ASK',
    "messaging" "AiMode" NOT NULL DEFAULT 'ASK',
    "roleAccess" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedById" UUID,

    CONSTRAINT "AiAgentPolicy_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AiAgentPolicy_clubId_key" ON "AiAgentPolicy"("clubId");
ALTER TABLE "AiAgentPolicy" ADD CONSTRAINT "AiAgentPolicy_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AiAction" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "status" "AiActionStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" UUID,
    "requestedRole" "UserRole" NOT NULL,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "executedAt" TIMESTAMPTZ(3),
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AiAction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiAction_clubId_status_createdAt_idx" ON "AiAction"("clubId", "status", "createdAt");
ALTER TABLE "AiAction" ADD CONSTRAINT "AiAction_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
