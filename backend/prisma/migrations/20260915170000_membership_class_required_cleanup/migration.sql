-- Finalize co-op membership cleanup.
-- MemberTier / Member.tier / Member.expiresAt / Store.tierDiscount* were dropped in
-- 20260915160000; this migration defensively re-drops leftovers and makes
-- Member.membershipClassId REQUIRED now that every member has been backfilled.

-- Ensure canonical classes exist for any null-class members.
INSERT INTO "MembershipClass" ("id", "name", "contributionAmount", "votingRights", "dividendWeight", "isActive", "description", "createdAt")
VALUES
  ('mc_member_100', 'Member $100', 100.00, 1, 1.0000, true,
   'Lifetime capital contribution of $100. One member, one vote. dividendWeight proportional to contribution.',
   CURRENT_TIMESTAMP),
  ('mc_member_1000', 'Member $1,000', 1000.00, 1, 10.0000, true,
   'Lifetime capital contribution of $1,000. One member, one vote. dividendWeight proportional to contribution.',
   CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- Backfill any remaining null class assignments onto the default $100 class.
UPDATE "Member"
SET "membershipClassId" = 'mc_member_100'
WHERE "membershipClassId" IS NULL;

ALTER TABLE "Member" ALTER COLUMN "membershipClassId" SET NOT NULL;

-- Defensive cleanup (no-ops if already removed).
ALTER TABLE "Member" DROP COLUMN IF EXISTS "tier";
ALTER TABLE "Member" DROP COLUMN IF EXISTS "expiresAt";
DROP TYPE IF EXISTS "MemberTier";
ALTER TABLE "Store" DROP COLUMN IF EXISTS "tierDiscountStandard";
ALTER TABLE "Store" DROP COLUMN IF EXISTS "tierDiscountPlus";
ALTER TABLE "Store" DROP COLUMN IF EXISTS "tierDiscountExecutive";
