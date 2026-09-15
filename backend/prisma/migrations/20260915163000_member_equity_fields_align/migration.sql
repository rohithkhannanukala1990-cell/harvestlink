-- Member field alignment (additive / non-destructive).
-- Renames taxIdLast4Encrypted → taxIdLast4, makes membershipClassId nullable again for
-- phased backfill semantics, sets isEligibleToVote default to true, adds missing indexes.
-- Does NOT reintroduce tier/expiresAt (already removed in coop_membership_equity).

ALTER TABLE "Member" RENAME COLUMN "taxIdLast4Encrypted" TO "taxIdLast4";

ALTER TABLE "Member" ALTER COLUMN "membershipClassId" DROP NOT NULL;

ALTER TABLE "Member" ALTER COLUMN "isEligibleToVote" SET DEFAULT true;

CREATE INDEX IF NOT EXISTS "Member_approvedByUserId_idx" ON "Member"("approvedByUserId");
CREATE INDEX IF NOT EXISTS "Member_householdPrimaryMemberId_idx" ON "Member"("householdPrimaryMemberId");
