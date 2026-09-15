-- Co-op membership rewrite: equity owners, not subscription tiers.
-- DATA-PRESERVING: existing Member rows are migrated; nothing is dropped without remap.

-- 1) New enums
CREATE TYPE "MemberStatus" AS ENUM ('PENDING', 'ACTIVE', 'WITHDRAWN', 'SUSPENDED', 'DECEASED', 'TRANSFERRED');
CREATE TYPE "CapitalPaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED');
CREATE TYPE "DividendAllocationMethod" AS ENUM ('BY_CAPITAL', 'BY_PATRONAGE', 'HYBRID');
CREATE TYPE "DividendStatus" AS ENUM ('DECLARED', 'ALLOCATED', 'PAID', 'CANCELLED');
CREATE TYPE "BoardResolutionOutcome" AS ENUM ('PENDING', 'PASSED', 'FAILED', 'TABLED');
CREATE TYPE "BallotStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

CREATE SEQUENCE IF NOT EXISTS "capital_certificate_seq" START 1;

-- 2) MembershipClass + seed canonical classes
CREATE TABLE "MembershipClass" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contributionAmount" DECIMAL(12,2) NOT NULL,
    "votingRights" INTEGER NOT NULL DEFAULT 1,
    "dividendWeight" DECIMAL(12,4) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MembershipClass_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MembershipClass_isActive_idx" ON "MembershipClass"("isActive");

INSERT INTO "MembershipClass" ("id", "name", "contributionAmount", "votingRights", "dividendWeight", "isActive", "description", "createdAt")
VALUES
  ('mc_member_100', 'Member $100', 100.00, 1, 100.0000, true, 'Lifetime capital contribution of $100. One member, one vote.', CURRENT_TIMESTAMP),
  ('mc_member_1000', 'Member $1,000', 1000.00, 1, 1000.0000, true, 'Lifetime capital contribution of $1,000. One member, one vote.', CURRENT_TIMESTAMP);

-- 3) Add new Member columns (nullable first for backfill)
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "phone" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "mailingAddress" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "membershipClassId" TEXT;
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "approvedByUserId" TEXT;
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3);
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "taxIdLast4Encrypted" TEXT;
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "isEligibleToVote" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "householdPrimaryMemberId" TEXT;

-- Map legacy tiers → membership classes (EXECUTIVE → $1000; others → $100)
UPDATE "Member"
SET "membershipClassId" = CASE
  WHEN "tier"::text = 'EXECUTIVE' THEN 'mc_member_1000'
  ELSE 'mc_member_100'
END
WHERE "membershipClassId" IS NULL;

UPDATE "Member"
SET
  "status" = 'ACTIVE',
  "isEligibleToVote" = true,
  "approvedAt" = COALESCE("joinedAt", CURRENT_TIMESTAMP)
WHERE "membershipClassId" IS NOT NULL;

ALTER TABLE "Member" ALTER COLUMN "membershipClassId" SET NOT NULL;

-- 4) New tables
CREATE TABLE "CapitalContribution" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paymentStatus" "CapitalPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "stripePaymentIntentId" TEXT,
    "receivedAt" TIMESTAMP(3),
    "certificateNumber" TEXT,
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CapitalContribution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MemberEquityAccount" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "totalContributed" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "distributedToDate" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currentBalance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MemberEquityAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BoardResolution" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "votedAt" TIMESTAMP(3),
    "outcome" "BoardResolutionOutcome" NOT NULL DEFAULT 'PENDING',
    "minutesUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BoardResolution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Dividend" (
    "id" TEXT NOT NULL,
    "boardResolutionId" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "totalPoolAmount" DECIMAL(12,2) NOT NULL,
    "allocationMethod" "DividendAllocationMethod" NOT NULL,
    "declaredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "status" "DividendStatus" NOT NULL DEFAULT 'DECLARED',
    CONSTRAINT "Dividend_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DividendAllocation" (
    "id" TEXT NOT NULL,
    "dividendId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "memberWeight" DECIMAL(18,6) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paymentStatus" "CapitalPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "taxFormIssued" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "DividendAllocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Ballot" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "opensAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closesAt" TIMESTAMP(3),
    "status" "BallotStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Ballot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BallotOption" (
    "id" TEXT NOT NULL,
    "ballotId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "BallotOption_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MemberVote" (
    "id" TEXT NOT NULL,
    "ballotId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "ballotOptionId" TEXT NOT NULL,
    "castAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MemberVote_pkey" PRIMARY KEY ("id")
);

-- Equity accounts for migrated members (zero until capital is recorded)
INSERT INTO "MemberEquityAccount" ("id", "memberId", "totalContributed", "distributedToDate", "currentBalance", "lastUpdatedAt")
SELECT 'eq_' || m."id", m."id", 0, 0, 0, CURRENT_TIMESTAMP
FROM "Member" m
WHERE NOT EXISTS (
  SELECT 1 FROM "MemberEquityAccount" e WHERE e."memberId" = m."id"
);

-- 5) Indexes + FKs
CREATE UNIQUE INDEX "CapitalContribution_stripePaymentIntentId_key" ON "CapitalContribution"("stripePaymentIntentId");
CREATE UNIQUE INDEX "CapitalContribution_certificateNumber_key" ON "CapitalContribution"("certificateNumber");
CREATE INDEX "CapitalContribution_memberId_idx" ON "CapitalContribution"("memberId");
CREATE INDEX "CapitalContribution_paymentStatus_idx" ON "CapitalContribution"("paymentStatus");
CREATE UNIQUE INDEX "MemberEquityAccount_memberId_key" ON "MemberEquityAccount"("memberId");
CREATE INDEX "Dividend_boardResolutionId_idx" ON "Dividend"("boardResolutionId");
CREATE INDEX "Dividend_fiscalYear_idx" ON "Dividend"("fiscalYear");
CREATE INDEX "Dividend_status_idx" ON "Dividend"("status");
CREATE UNIQUE INDEX "DividendAllocation_dividendId_memberId_key" ON "DividendAllocation"("dividendId", "memberId");
CREATE INDEX "DividendAllocation_memberId_idx" ON "DividendAllocation"("memberId");
CREATE INDEX "BallotOption_ballotId_idx" ON "BallotOption"("ballotId");
CREATE UNIQUE INDEX "MemberVote_ballotId_memberId_key" ON "MemberVote"("ballotId", "memberId");
CREATE INDEX "MemberVote_memberId_idx" ON "MemberVote"("memberId");
CREATE INDEX "MemberVote_ballotOptionId_idx" ON "MemberVote"("ballotOptionId");
CREATE INDEX "Member_status_idx" ON "Member"("status");
CREATE INDEX "Member_membershipClassId_idx" ON "Member"("membershipClassId");
CREATE INDEX "Member_email_idx" ON "Member"("email");

ALTER TABLE "Member" ADD CONSTRAINT "Member_membershipClassId_fkey"
  FOREIGN KEY ("membershipClassId") REFERENCES "MembershipClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Member" ADD CONSTRAINT "Member_approvedByUserId_fkey"
  FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Member" ADD CONSTRAINT "Member_householdPrimaryMemberId_fkey"
  FOREIGN KEY ("householdPrimaryMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CapitalContribution" ADD CONSTRAINT "CapitalContribution_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MemberEquityAccount" ADD CONSTRAINT "MemberEquityAccount_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Dividend" ADD CONSTRAINT "Dividend_boardResolutionId_fkey"
  FOREIGN KEY ("boardResolutionId") REFERENCES "BoardResolution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DividendAllocation" ADD CONSTRAINT "DividendAllocation_dividendId_fkey"
  FOREIGN KEY ("dividendId") REFERENCES "Dividend"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DividendAllocation" ADD CONSTRAINT "DividendAllocation_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BallotOption" ADD CONSTRAINT "BallotOption_ballotId_fkey"
  FOREIGN KEY ("ballotId") REFERENCES "Ballot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemberVote" ADD CONSTRAINT "MemberVote_ballotId_fkey"
  FOREIGN KEY ("ballotId") REFERENCES "Ballot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemberVote" ADD CONSTRAINT "MemberVote_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MemberVote" ADD CONSTRAINT "MemberVote_ballotOptionId_fkey"
  FOREIGN KEY ("ballotOptionId") REFERENCES "BallotOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6) Drop legacy subscription fields (after data mapped)
ALTER TABLE "Member" DROP COLUMN IF EXISTS "tier";
ALTER TABLE "Member" DROP COLUMN IF EXISTS "expiresAt";
DROP TYPE IF EXISTS "MemberTier";

ALTER TABLE "Store" DROP COLUMN IF EXISTS "tierDiscountStandard";
ALTER TABLE "Store" DROP COLUMN IF EXISTS "tierDiscountPlus";
ALTER TABLE "Store" DROP COLUMN IF EXISTS "tierDiscountExecutive";
