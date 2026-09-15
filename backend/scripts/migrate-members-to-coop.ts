/**
 * Legacy member backfill helper (post MembershipClass removal).
 *
 * Idempotent — safe to run twice. Ensures CooperativeSettings exists and creates a
 * PENDING MembershipFee ($100) for any member missing one. Does NOT invent
 * CapitalInvestment rows — verified capital must be recorded by hand via
 * membership.service.recordCapitalInvestment.
 *
 * MembershipClass is gone: fee vs capital investment are separate models.
 */
import { MembershipFeeStatus, Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";

const JOINING_FEE = new Prisma.Decimal(100);

async function ensureCooperativeSettings(): Promise<void> {
  const existing = await prisma.cooperativeSettings.findFirst();
  if (existing) {
    console.log(`Ensured CooperativeSettings (${existing.id}), threshold=${existing.votingThresholdAmount}`);
    return;
  }
  const created = await prisma.cooperativeSettings.create({
    data: {
      id: "coop_settings_default",
      votingThresholdAmount: new Prisma.Decimal(1000),
      fiscalYearEnd: "12-31",
      legalEntityName: "Harvestlink Cooperative",
      stateOfIncorporation: "",
    },
  });
  console.log(`Created CooperativeSettings (${created.id})`);
}

async function main(): Promise<void> {
  await ensureCooperativeSettings();

  const members = await prisma.member.findMany({
    select: {
      id: true,
      memberNumber: true,
      status: true,
      membershipFees: { select: { id: true }, take: 1 },
    },
  });

  let feesCreated = 0;
  for (const member of members) {
    if (member.membershipFees.length > 0) continue;
    await prisma.membershipFee.create({
      data: {
        memberId: member.id,
        amount: JOINING_FEE,
        paymentMethod: "backfill",
        paymentStatus: MembershipFeeStatus.PENDING,
      },
    });
    feesCreated += 1;
    console.log(`Created MembershipFee for ${member.memberNumber} (${member.id})`);
  }

  console.log(
    `\nDone. MembershipFees created: ${feesCreated}. No CapitalInvestment rows were invented.`,
  );
  console.log(
    "Record verified capital via membership.service.recordCapitalInvestment; voting rights recompute on CONFIRMED.",
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
