-- Configurable member benefits (R2): versioned perks + usage tracking + store bearer flags.

-- Enums
CREATE TYPE "BenefitType" AS ENUM (
  'PERCENT_DISCOUNT',
  'FIXED_DISCOUNT',
  'FREE_DELIVERY',
  'EARLY_ACCESS',
  'EXCLUSIVE_PRODUCT',
  'BULK_PRICING',
  'BIRTHDAY_CREDIT',
  'STORE_CREDIT',
  'FREE_ITEM'
);

CREATE TYPE "BenefitScope" AS ENUM (
  'ALL_PRODUCTS',
  'CATEGORY',
  'PRODUCT',
  'STORE',
  'NETWORK_WIDE'
);

CREATE TYPE "BenefitPeriod" AS ENUM (
  'PER_TRANSACTION',
  'DAILY',
  'MONTHLY',
  'ANNUAL',
  'LIFETIME'
);

CREATE TYPE "DiscountBearer" AS ENUM (
  'OPERATOR',
  'COOP',
  'SHARED'
);

-- Store: network benefit opt-out + who funds member discounts
ALTER TABLE "Store" ADD COLUMN "honorsNetworkBenefits" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Store" ADD COLUMN "memberDiscountBearer" "DiscountBearer" NOT NULL DEFAULT 'COOP';
ALTER TABLE "Store" ADD COLUMN "memberDiscountSharedPercent" DECIMAL(5,2) NOT NULL DEFAULT 0;

-- MemberBenefit (versioned — never overwrite; end old row + insert new)
CREATE TABLE "MemberBenefit" (
    "id" TEXT NOT NULL,
    "membershipClassId" TEXT NOT NULL,
    "benefitType" "BenefitType" NOT NULL,
    "value" DECIMAL(12,4) NOT NULL,
    "scope" "BenefitScope" NOT NULL,
    "scopeRefId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "maxUsesPerPeriod" INTEGER,
    "periodType" "BenefitPeriod" NOT NULL DEFAULT 'PER_TRANSACTION',
    "minimumPurchaseAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "description" TEXT NOT NULL DEFAULT '',
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberBenefit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MemberBenefit_membershipClassId_idx" ON "MemberBenefit"("membershipClassId");
CREATE INDEX "MemberBenefit_isActive_startsAt_endsAt_idx" ON "MemberBenefit"("isActive", "startsAt", "endsAt");
CREATE INDEX "MemberBenefit_benefitType_idx" ON "MemberBenefit"("benefitType");
CREATE INDEX "MemberBenefit_priority_idx" ON "MemberBenefit"("priority");
CREATE INDEX "MemberBenefit_createdByUserId_idx" ON "MemberBenefit"("createdByUserId");

ALTER TABLE "MemberBenefit"
  ADD CONSTRAINT "MemberBenefit_membershipClassId_fkey"
  FOREIGN KEY ("membershipClassId") REFERENCES "MembershipClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MemberBenefit"
  ADD CONSTRAINT "MemberBenefit_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- MemberBenefitUsage (caps + co-op cost of perks)
CREATE TABLE "MemberBenefitUsage" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "benefitId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "amountSaved" DECIMAL(12,2) NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberBenefitUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MemberBenefitUsage_memberId_benefitId_usedAt_idx"
  ON "MemberBenefitUsage"("memberId", "benefitId", "usedAt");
CREATE INDEX "MemberBenefitUsage_saleId_idx" ON "MemberBenefitUsage"("saleId");
CREATE INDEX "MemberBenefitUsage_benefitId_idx" ON "MemberBenefitUsage"("benefitId");

ALTER TABLE "MemberBenefitUsage"
  ADD CONSTRAINT "MemberBenefitUsage_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MemberBenefitUsage"
  ADD CONSTRAINT "MemberBenefitUsage_benefitId_fkey"
  FOREIGN KEY ("benefitId") REFERENCES "MemberBenefit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MemberBenefitUsage"
  ADD CONSTRAINT "MemberBenefitUsage_saleId_fkey"
  FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
