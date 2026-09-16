-- Recall workflow models (regulatory retention — no deletes).

CREATE TYPE "RecallSeverity" AS ENUM ('ADVISORY', 'VOLUNTARY', 'MANDATORY');
CREATE TYPE "RecallStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED');
CREATE TYPE "RecallNotificationChannel" AS ENUM ('EMAIL', 'SMS', 'WHATSAPP');

CREATE TABLE "Recall" (
    "id" TEXT NOT NULL,
    "recallNumber" TEXT NOT NULL,
    "initiatedByUserId" TEXT NOT NULL,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "severity" "RecallSeverity" NOT NULL,
    "status" "RecallStatus" NOT NULL DEFAULT 'DRAFT',
    "regulatorNotifiedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "publicNotice" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recall_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Recall_recallNumber_key" ON "Recall"("recallNumber");
CREATE INDEX "Recall_status_idx" ON "Recall"("status");
CREATE INDEX "Recall_initiatedAt_idx" ON "Recall"("initiatedAt");
CREATE INDEX "Recall_initiatedByUserId_idx" ON "Recall"("initiatedByUserId");

CREATE TABLE "RecallLot" (
    "id" TEXT NOT NULL,
    "recallId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "quantityAtRecall" INTEGER NOT NULL,
    "quantityRecovered" INTEGER NOT NULL DEFAULT 0,
    "quantityDisposed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RecallLot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RecallLot_recallId_lotId_key" ON "RecallLot"("recallId", "lotId");
CREATE INDEX "RecallLot_lotId_idx" ON "RecallLot"("lotId");
CREATE INDEX "RecallLot_recallId_idx" ON "RecallLot"("recallId");

CREATE TABLE "RecallNotification" (
    "id" TEXT NOT NULL,
    "recallId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "channel" "RecallNotificationChannel" NOT NULL,
    "sentAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "quantityPurchased" INTEGER NOT NULL,

    CONSTRAINT "RecallNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RecallNotification_recallId_memberId_channel_key" ON "RecallNotification"("recallId", "memberId", "channel");
CREATE INDEX "RecallNotification_recallId_idx" ON "RecallNotification"("recallId");
CREATE INDEX "RecallNotification_memberId_idx" ON "RecallNotification"("memberId");

ALTER TABLE "Recall" ADD CONSTRAINT "Recall_initiatedByUserId_fkey" FOREIGN KEY ("initiatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecallLot" ADD CONSTRAINT "RecallLot_recallId_fkey" FOREIGN KEY ("recallId") REFERENCES "Recall"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecallLot" ADD CONSTRAINT "RecallLot_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecallNotification" ADD CONSTRAINT "RecallNotification_recallId_fkey" FOREIGN KEY ("recallId") REFERENCES "Recall"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecallNotification" ADD CONSTRAINT "RecallNotification_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
