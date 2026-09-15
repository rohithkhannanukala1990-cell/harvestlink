/**
 * Data migration: move legacy Member rows onto the cooperative equity model.
 *
 * Idempotent — safe to run twice. Does not invent CapitalContribution rows
 * (that would misstate the co-op balance sheet).
 *
 * Usage: npx tsx scripts/migrate-members-to-coop.ts
 */
import { MemberStatus, Prisma, PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

const CLASS_100 = "Member $100";
const CLASS_1000 = "Member $1,000";

async function ensureMembershipClass(input: {
  name: string;
  contributionAmount: number;
  /** Relative weight for capital-based dividends — proportional to contributionAmount. */
  dividendWeight: number;
  description: string;
}): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.membershipClass.findFirst({
    where: { name: input.name },
  });

  if (existing) {
    await prisma.membershipClass.update({
      where: { id: existing.id },
      data: {
        contributionAmount: new Prisma.Decimal(input.contributionAmount),
        votingRights: 1,
        // dividendWeight is proportional to contribution ($100 → 1, $1,000 → 10).
        dividendWeight: new Prisma.Decimal(input.dividendWeight),
        isActive: true,
        description: input.description,
      },
    });
    return { id: existing.id, created: false };
  }

  const created = await prisma.membershipClass.create({
    data: {
      name: input.name,
      contributionAmount: new Prisma.Decimal(input.contributionAmount),
      votingRights: 1,
      // dividendWeight is proportional to contribution ($100 → 1, $1,000 → 10).
      dividendWeight: new Prisma.Decimal(input.dividendWeight),
      isActive: true,
      description: input.description,
    },
  });
  return { id: created.id, created: true };
}

async function main(): Promise<void> {
  console.log("=== Harvestlink member → co-op data migration ===\n");

  const class100 = await ensureMembershipClass({
    name: CLASS_100,
    contributionAmount: 100,
    dividendWeight: 1,
    description:
      "Lifetime capital contribution of $100. One member, one vote. dividendWeight is proportional to contribution.",
  });
  console.log(
    class100.created
      ? `Created MembershipClass: ${CLASS_100} (${class100.id})`
      : `Ensured MembershipClass: ${CLASS_100} (${class100.id})`,
  );

  const class1000 = await ensureMembershipClass({
    name: CLASS_1000,
    contributionAmount: 1000,
    dividendWeight: 10,
    description:
      "Lifetime capital contribution of $1,000. One member, one vote. dividendWeight is proportional to contribution.",
  });
  console.log(
    class1000.created
      ? `Created MembershipClass: ${CLASS_1000} (${class1000.id})`
      : `Ensured MembershipClass: ${CLASS_1000} (${class1000.id})`,
  );

  const members = await prisma.member.findMany({
    select: {
      id: true,
      memberNumber: true,
      membershipClassId: true,
      status: true,
      equityAccount: { select: { id: true } },
      contributions: { select: { id: true }, take: 1 },
    },
    orderBy: { joinedAt: "asc" },
  });

  let membersMigrated = 0;
  let equityAccountsCreated = 0;
  let membersAlreadyAligned = 0;

  // Do NOT create CapitalContribution for legacy members.
  // We have no reliable record that they paid capital; inventing a PAID equity
  // row would inflate MemberEquityAccount totals and misstate the co-op's
  // balance sheet. Zero-balance equity accounts only — real contributions must
  // be recorded manually after verification.
  for (const member of members) {
    const needsClass = member.membershipClassId == null;
    const needsStatus = member.status !== MemberStatus.ACTIVE;
    const needsEquity = member.equityAccount == null;

    if (!needsClass && !needsStatus && !needsEquity) {
      membersAlreadyAligned += 1;
      continue;
    }

    await prisma.$transaction(async (tx) => {
      if (needsClass || needsStatus) {
        await tx.member.update({
          where: { id: member.id },
          data: {
            // Default legacy members onto the $100 class; staff can upgrade later.
            ...(needsClass ? { membershipClassId: class100.id } : {}),
            ...(needsStatus ? { status: MemberStatus.ACTIVE } : {}),
            ...(needsStatus
              ? { approvedAt: new Date(), isEligibleToVote: true }
              : {}),
          },
        });
      }

      if (needsEquity) {
        await tx.memberEquityAccount.create({
          data: {
            memberId: member.id,
            totalContributed: new Prisma.Decimal(0),
            distributedToDate: new Prisma.Decimal(0),
            currentBalance: new Prisma.Decimal(0),
          },
        });
        equityAccountsCreated += 1;
      }
    });

    membersMigrated += 1;
  }

  // Anyone without a CapitalContribution still needs a real buy-in recorded by hand.
  const needManualContribution = await prisma.member.count({
    where: { contributions: { none: {} } },
  });

  console.log("\n--- Summary ---");
  console.log(`Members scanned:              ${members.length}`);
  console.log(`Members migrated this run:    ${membersMigrated}`);
  console.log(`Already aligned (skipped):    ${membersAlreadyAligned}`);
  console.log(`Equity accounts created:      ${equityAccountsCreated}`);
  console.log(
    `Need manual contribution review: ${needManualContribution}`,
  );
  console.log(
    "\nNo CapitalContribution rows were created. Record verified capital",
  );
  console.log("payments manually so equity totals match the balance sheet.");
}

main()
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
