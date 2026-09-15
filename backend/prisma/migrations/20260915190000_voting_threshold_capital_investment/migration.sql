-- Voting threshold / fee vs capital investment separation.
-- $100 joining fee ≠ MembershipFee (NO votes).
-- CapitalInvestment (variable, typically $1,000+) grants voting when totalInvested >= threshold.
-- Drops MembershipClass; renames CapitalContribution → CapitalInvestment; PAID → CONFIRMED.

-- ─── 1) Enums ────────────────────────────────────────────────────────────────
ALTER TYPE "CapitalPaymentStatus" RENAME VALUE 'PAID' TO 'CONFIRMED';

CREATE TYPE "MembershipFeeStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');

-- ─── 2) CooperativeSettings (threshold lives here — never hardcoded) ─────────
CREATE TABLE "CooperativeSettings" (
    "id" TEXT NOT NULL,
    "votingThresholdAmount" DECIMAL(12,2) NOT NULL DEFAULT 1000,
    "fiscalYearEnd" TEXT NOT NULL DEFAULT '12-31',
    "legalEntityName" TEXT NOT NULL DEFAULT 'Harvestlink Cooperative',
    "stateOfIncorporation" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CooperativeSettings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "CooperativeSettings" (
  "id", "votingThresholdAmount", "fiscalYearEnd", "legalEntityName",
  "stateOfIncorporation", "createdAt", "updatedAt"
) VALUES (
  'coop_settings_default', 1000, '12-31', 'Harvestlink Cooperative', '',
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

-- ─── 3) MembershipFee ────────────────────────────────────────────────────────
CREATE TABLE "MembershipFee" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL DEFAULT 100,
    "paymentMethod" TEXT NOT NULL DEFAULT '',
    "paymentReference" TEXT,
    "paymentStatus" "MembershipFeeStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "confirmedByUserId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MembershipFee_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MembershipFee_memberId_idx" ON "MembershipFee"("memberId");
CREATE INDEX "MembershipFee_paymentStatus_idx" ON "MembershipFee"("paymentStatus");
CREATE INDEX "MembershipFee_confirmedByUserId_idx" ON "MembershipFee"("confirmedByUserId");

ALTER TABLE "MembershipFee"
  ADD CONSTRAINT "MembershipFee_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MembershipFee"
  ADD CONSTRAINT "MembershipFee_confirmedByUserId_fkey"
  FOREIGN KEY ("confirmedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Map every existing member to a MembershipFee (joining fee — NO votes).
-- Prefer MembershipClass.contributionAmount when it was the $100 joining tier;
-- otherwise default to $100. ACTIVE / approved members → CONFIRMED.
INSERT INTO "MembershipFee" (
  "id", "memberId", "amount", "paymentMethod", "paymentReference",
  "paymentStatus", "paidAt", "confirmedByUserId", "confirmedAt", "createdAt"
)
SELECT
  'mf_' || m."id",
  m."id",
  CASE
    WHEN mc."contributionAmount" IS NOT NULL AND mc."contributionAmount" <= 100
      THEN mc."contributionAmount"
    ELSE 100
  END,
  'migrated',
  'from MembershipClass ' || COALESCE(m."membershipClassId", 'none'),
  CASE
    WHEN m."status" IN ('ACTIVE', 'SUSPENDED', 'WITHDRAWN', 'DECEASED', 'TRANSFERRED')
      THEN 'CONFIRMED'::"MembershipFeeStatus"
    ELSE 'PENDING'::"MembershipFeeStatus"
  END,
  CASE
    WHEN m."status" IN ('ACTIVE', 'SUSPENDED', 'WITHDRAWN', 'DECEASED', 'TRANSFERRED')
      THEN COALESCE(m."approvedAt", m."joinedAt")
    ELSE NULL
  END,
  m."approvedByUserId",
  CASE
    WHEN m."status" IN ('ACTIVE', 'SUSPENDED', 'WITHDRAWN', 'DECEASED', 'TRANSFERRED')
      THEN COALESCE(m."approvedAt", m."joinedAt")
    ELSE NULL
  END,
  m."joinedAt"
FROM "Member" m
LEFT JOIN "MembershipClass" mc ON mc."id" = m."membershipClassId";

-- ─── 4) CapitalContribution → CapitalInvestment ──────────────────────────────
ALTER TABLE "CapitalContribution" RENAME TO "CapitalInvestment";

ALTER TABLE "CapitalInvestment" RENAME CONSTRAINT "CapitalContribution_pkey" TO "CapitalInvestment_pkey";
ALTER TABLE "CapitalInvestment" RENAME CONSTRAINT "CapitalContribution_memberId_fkey" TO "CapitalInvestment_memberId_fkey";

ALTER INDEX "CapitalContribution_stripePaymentIntentId_key" RENAME TO "CapitalInvestment_stripePaymentIntentId_key";
ALTER INDEX "CapitalContribution_certificateNumber_key" RENAME TO "CapitalInvestment_certificateNumber_key";
ALTER INDEX "CapitalContribution_memberId_idx" RENAME TO "CapitalInvestment_memberId_idx";
ALTER INDEX "CapitalContribution_paymentStatus_idx" RENAME TO "CapitalInvestment_paymentStatus_idx";

ALTER TABLE "CapitalInvestment" ADD COLUMN "paymentMethod" TEXT NOT NULL DEFAULT '';
ALTER TABLE "CapitalInvestment" ADD COLUMN "paymentReference" TEXT;
ALTER TABLE "CapitalInvestment" ADD COLUMN "confirmedByUserId" TEXT;
ALTER TABLE "CapitalInvestment" ADD COLUMN "subscriptionAgreementUrl" TEXT;

CREATE INDEX "CapitalInvestment_confirmedByUserId_idx" ON "CapitalInvestment"("confirmedByUserId");

ALTER TABLE "CapitalInvestment"
  ADD CONSTRAINT "CapitalInvestment_confirmedByUserId_fkey"
  FOREIGN KEY ("confirmedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "CapitalInvestment"
SET "paymentMethod" = CASE
  WHEN "stripePaymentIntentId" IS NOT NULL THEN 'card'
  ELSE 'migrated'
END
WHERE "paymentMethod" = '';

-- ─── 5) Member.totalInvested + hasVotingRights ───────────────────────────────
ALTER TABLE "Member" ADD COLUMN "totalInvested" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Member" ADD COLUMN "hasVotingRights" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Member_hasVotingRights_idx" ON "Member"("hasVotingRights");

-- Rollup CONFIRMED investments into totalInvested
UPDATE "Member" m
SET "totalInvested" = COALESCE((
  SELECT SUM(ci."amount")
  FROM "CapitalInvestment" ci
  WHERE ci."memberId" = m."id"
    AND ci."paymentStatus" = 'CONFIRMED'
    AND ci."refundedAt" IS NULL
), 0);

-- Voting rule: totalInvested >= CooperativeSettings.votingThresholdAmount
UPDATE "Member" m
SET "hasVotingRights" = (
  m."totalInvested" >= (
    SELECT cs."votingThresholdAmount" FROM "CooperativeSettings" cs LIMIT 1
  )
);

-- Keep equity ledger in sync with CONFIRMED investments
UPDATE "MemberEquityAccount" ea
SET
  "totalContributed" = COALESCE((
    SELECT SUM(ci."amount")
    FROM "CapitalInvestment" ci
    WHERE ci."memberId" = ea."memberId"
      AND ci."paymentStatus" = 'CONFIRMED'
      AND ci."refundedAt" IS NULL
  ), 0),
  "currentBalance" = COALESCE((
    SELECT SUM(ci."amount")
    FROM "CapitalInvestment" ci
    WHERE ci."memberId" = ea."memberId"
      AND ci."paymentStatus" = 'CONFIRMED'
      AND ci."refundedAt" IS NULL
  ), 0) - "distributedToDate",
  "lastUpdatedAt" = CURRENT_TIMESTAMP;

-- ─── 6) Detach MemberBenefit from MembershipClass (network-wide) ─────────────
ALTER TABLE "MemberBenefit" DROP CONSTRAINT IF EXISTS "MemberBenefit_membershipClassId_fkey";
DROP INDEX IF EXISTS "MemberBenefit_membershipClassId_idx";
ALTER TABLE "MemberBenefit" DROP COLUMN IF EXISTS "membershipClassId";

-- ─── 7) Detach Sale from MembershipClass ─────────────────────────────────────
ALTER TABLE "Sale" DROP CONSTRAINT IF EXISTS "Sale_membershipClassId_fkey";
DROP INDEX IF EXISTS "Sale_membershipClassId_idx";
ALTER TABLE "Sale" DROP COLUMN IF EXISTS "membershipClassId";

-- ─── 8) Detach Member from MembershipClass + drop class table ────────────────
ALTER TABLE "Member" DROP CONSTRAINT IF EXISTS "Member_membershipClassId_fkey";
DROP INDEX IF EXISTS "Member_membershipClassId_idx";
ALTER TABLE "Member" DROP COLUMN IF EXISTS "membershipClassId";

DROP TABLE IF EXISTS "MembershipClass";
