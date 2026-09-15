/**
 * Co-op membership & equity — Harvestlink members are OWNERS, not subscribers.
 *
 * HARD RULES (do not violate):
 * 1. Capital investments NEVER flow through createSale or settlement. Operators earn
 *    NO percentage on them. All equity payment paths live in THIS service only.
 * 2. Investments are EQUITY — excluded from sales revenue, store revenue, operator
 *    settlement, and P&L reporting. MembershipFee is separate (joining fee — confirm
 *    with accountant whether it is revenue or member capital).
 * 3. Voting rule:
 *    /// A member votes ONLY if totalInvested >= CooperativeSettings.votingThresholdAmount.
 *    /// Above the threshold every voting member gets EXACTLY ONE vote, whether they invested $1,000
 *    /// or $50,000. Investing more buys more dividend participation, never more votes.
 *    /// One member, one vote AMONG MEMBERS WITH VOTING RIGHTS.
 *    Enforced by @@unique([ballotId, memberId]) AND service-level hasVotingRights check.
 * 4. A Dividend cannot be created without a BoardResolution.
 * 5. Members are never hard-deleted. Withdrawal = status change + refund flow.
 * 6. taxIdLast4 is stored encrypted for dividend tax forms (1099-PATR vs 1099-DIV —
 *    classification must be confirmed with the co-op's accountant before issuing).
 *
 * Memberships NEVER expire. POS validates status === ACTIVE only.
 * The $100 joining fee and the $1,000+ capital investment are TWO SEPARATE THINGS.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  BallotStatus,
  BoardResolutionOutcome,
  CapitalPaymentStatus,
  DividendAllocationMethod,
  DividendStatus,
  MemberStatus,
  MembershipFeeStatus,
  Prisma,
  Role,
  type Ballot,
  type BoardResolution,
  type CapitalInvestment,
  type CooperativeSettings,
  type Dividend,
  type Member,
  type MembershipFee,
  type Sale,
  type SaleItem,
} from "@prisma/client";
import { AuditAction, writeAuditLog } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { encryptTaxIdLast4 } from "../lib/memberPii.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../types/auth.js";

function money(value: Prisma.Decimal | string | number): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

function assertCoopAdmin(actor: AuthUser): void {
  if (actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Only COOP_ADMIN may perform this membership action");
  }
}

function assertMemberAdmin(actor: AuthUser): void {
  if (actor.role !== Role.STORE_ADMIN && actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Insufficient role for membership administration");
  }
}

async function generateUniqueMemberNumber(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `HL-${randomBytes(4).toString("hex").toUpperCase()}`;
    const existing = await prisma.member.findUnique({
      where: { memberNumber: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }
  return `HL-${createHash("sha1")
    .update(`${Date.now()}-${randomBytes(8).toString("hex")}`)
    .digest("hex")
    .slice(0, 10)
    .toUpperCase()}`;
}

async function nextCertificateNumber(tx: Prisma.TransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ n: bigint | number }>>`
    SELECT nextval('capital_certificate_seq') AS n
  `;
  return `EQ-${String(Number(rows[0]?.n ?? 0)).padStart(6, "0")}`;
}

/** Ensures a CooperativeSettings singleton exists and returns it. */
export async function getCooperativeSettings(
  tx?: Prisma.TransactionClient,
): Promise<CooperativeSettings> {
  const client = tx ?? prisma;
  const existing = await client.cooperativeSettings.findFirst({
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;
  return client.cooperativeSettings.create({
    data: {
      id: "coop_settings_default",
      votingThresholdAmount: money(1000),
      fiscalYearEnd: "12-31",
      legalEntityName: "Harvestlink Cooperative",
      stateOfIncorporation: "",
    },
  });
}

export async function updateCooperativeSettings(
  actor: AuthUser,
  input: Partial<{
    votingThresholdAmount: number;
    fiscalYearEnd: string;
    legalEntityName: string;
    stateOfIncorporation: string;
  }>,
): Promise<CooperativeSettings> {
  assertCoopAdmin(actor);
  const settings = await getCooperativeSettings();
  const updated = await prisma.cooperativeSettings.update({
    where: { id: settings.id },
    data: {
      ...(input.votingThresholdAmount !== undefined
        ? { votingThresholdAmount: money(input.votingThresholdAmount) }
        : {}),
      ...(input.fiscalYearEnd !== undefined
        ? { fiscalYearEnd: input.fiscalYearEnd.trim() }
        : {}),
      ...(input.legalEntityName !== undefined
        ? { legalEntityName: input.legalEntityName.trim() }
        : {}),
      ...(input.stateOfIncorporation !== undefined
        ? { stateOfIncorporation: input.stateOfIncorporation.trim() }
        : {}),
    },
  });

  // Lowering / raising the threshold re-enfranchises or disenfranchises correctly.
  if (input.votingThresholdAmount !== undefined) {
    await prisma.$transaction(async (tx) => {
      const members = await tx.member.findMany({ select: { id: true } });
      for (const m of members) {
        await recomputeVotingRights(tx, m.id);
      }
    });
  }

  return updated;
}

/**
 * Recomputes Member.totalInvested and Member.hasVotingRights from CONFIRMED investments.
 * Call whenever a CapitalInvestment is CONFIRMED or refunded.
 *
 * /// A member votes ONLY if totalInvested >= CooperativeSettings.votingThresholdAmount.
 * /// Above the threshold every voting member gets EXACTLY ONE vote, whether they invested $1,000
 * /// or $50,000. Investing more buys more dividend participation, never more votes.
 * /// One member, one vote AMONG MEMBERS WITH VOTING RIGHTS.
 */
export async function recomputeVotingRights(
  tx: Prisma.TransactionClient,
  memberId: string,
): Promise<{ totalInvested: Prisma.Decimal; hasVotingRights: boolean }> {
  const confirmed = await tx.capitalInvestment.aggregate({
    where: {
      memberId,
      paymentStatus: CapitalPaymentStatus.CONFIRMED,
      refundedAt: null,
    },
    _sum: { amount: true },
  });
  const totalInvested = money(confirmed._sum.amount ?? 0);
  const settings = await getCooperativeSettings(tx);
  const hasVotingRights = totalInvested.gte(settings.votingThresholdAmount);

  await tx.member.update({
    where: { id: memberId },
    data: { totalInvested, hasVotingRights },
  });

  return { totalInvested, hasVotingRights };
}

/**
 * Recomputes MemberEquityAccount from CONFIRMED capital − refunded + dividend distributions.
 * Equity math is intentionally separate from Sale / settlement pipelines.
 */
async function refreshEquityAccount(
  tx: Prisma.TransactionClient,
  memberId: string,
): Promise<void> {
  const confirmed = await tx.capitalInvestment.aggregate({
    where: {
      memberId,
      paymentStatus: CapitalPaymentStatus.CONFIRMED,
      refundedAt: null,
    },
    _sum: { amount: true },
  });
  const distributed = await tx.dividendAllocation.aggregate({
    where: {
      memberId,
      paymentStatus: CapitalPaymentStatus.CONFIRMED,
    },
    _sum: { amount: true },
  });
  const totalContributed = money(confirmed._sum.amount ?? 0);
  const distributedToDate = money(distributed._sum.amount ?? 0);
  const currentBalance = money(totalContributed.sub(distributedToDate));

  await tx.memberEquityAccount.upsert({
    where: { memberId },
    create: {
      memberId,
      totalContributed,
      distributedToDate,
      currentBalance,
      lastUpdatedAt: new Date(),
    },
    update: {
      totalContributed,
      distributedToDate,
      currentBalance,
      lastUpdatedAt: new Date(),
    },
  });

  await recomputeVotingRights(tx, memberId);
}

// ─── Members ─────────────────────────────────────────────────────────────────

export type CreateMemberInput = {
  name: string;
  email: string;
  phone?: string;
  mailingAddress?: string;
  taxIdLast4?: string;
  householdPrimaryMemberId?: string | null;
  /** When true, create as ACTIVE immediately (admin onboarding). Default PENDING. */
  activate?: boolean;
  /** One-time joining fee amount (USD). Default $100. Confers NO voting rights. */
  joiningFeeAmount?: number;
};

export type UpdateMemberInput = Partial<{
  name: string;
  email: string;
  phone: string;
  mailingAddress: string;
  taxIdLast4: string | null;
  householdPrimaryMemberId: string | null;
  isEligibleToVote: boolean;
  status: MemberStatus;
}>;

export type ListMembersFilter = {
  q?: string;
  status?: MemberStatus;
  page: number;
  pageSize: number;
};

export type MemberSaleHistory = Sale & {
  items: SaleItem[];
  store: { id: string; name: string };
};

const memberInclude = {
  equityAccount: true,
  membershipFees: { orderBy: { createdAt: "asc" as const } },
} as const;

export async function listMembers(filter: ListMembersFilter) {
  const q = filter.q?.trim();
  const where: Prisma.MemberWhereInput = {
    ...(filter.status ? { status: filter.status } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { memberNumber: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const skip = (filter.page - 1) * filter.pageSize;
  const [total, members] = await prisma.$transaction([
    prisma.member.count({ where }),
    prisma.member.findMany({
      where,
      include: memberInclude,
      orderBy: [{ name: "asc" }],
      skip,
      take: filter.pageSize,
    }),
  ]);

  return {
    members,
    page: filter.page,
    pageSize: filter.pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / filter.pageSize),
  };
}

export async function createMember(
  actor: AuthUser,
  input: CreateMemberInput,
): Promise<Member> {
  assertMemberAdmin(actor);

  const activate = Boolean(input.activate);
  const taxEnc = input.taxIdLast4?.trim()
    ? encryptTaxIdLast4(input.taxIdLast4.trim().slice(-4))
    : null;
  const feeAmount = money(input.joiningFeeAmount ?? 100);

  for (let attempt = 0; attempt < 3; attempt++) {
    const memberNumber = await generateUniqueMemberNumber();
    try {
      return await prisma.$transaction(async (tx) => {
        const member = await tx.member.create({
          data: {
            memberNumber,
            name: input.name.trim(),
            email: input.email.trim().toLowerCase(),
            phone: input.phone?.trim() ?? "",
            mailingAddress: input.mailingAddress?.trim() ?? "",
            status: activate ? MemberStatus.ACTIVE : MemberStatus.PENDING,
            approvedByUserId: activate ? actor.id : null,
            approvedAt: activate ? new Date() : null,
            taxIdLast4: taxEnc,
            isEligibleToVote: activate,
            totalInvested: money(0),
            hasVotingRights: false,
            householdPrimaryMemberId: input.householdPrimaryMemberId ?? null,
          },
          include: memberInclude,
        });
        await tx.memberEquityAccount.create({
          data: { memberId: member.id },
        });
        // Joining fee — confers NO voting rights. Separate from CapitalInvestment.
        await tx.membershipFee.create({
          data: {
            memberId: member.id,
            amount: feeAmount,
            paymentStatus: MembershipFeeStatus.PENDING,
          },
        });
        return member;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        continue;
      }
      throw error;
    }
  }
  throw new AppError(500, "Unable to allocate a unique memberNumber");
}

/**
 * POS card lookup. Memberships NEVER expire — only status === ACTIVE may shop as a member.
 */
export async function getMemberByNumber(memberNumber: string) {
  const member = await prisma.member.findUnique({
    where: { memberNumber },
    include: memberInclude,
  });
  if (!member) throw new AppError(404, "Member not found");
  return member;
}

/** Asserts ACTIVE for checkout attachment. Memberships never expire — no expiresAt check. */
export function assertMemberActiveForSale(member: {
  status: MemberStatus;
  memberNumber: string;
}): void {
  if (member.status !== MemberStatus.ACTIVE) {
    throw new AppError(400, "Member is not ACTIVE and cannot be attached to a sale", {
      memberNumber: member.memberNumber,
      status: member.status,
    });
  }
}

export async function updateMember(
  actor: AuthUser,
  id: string,
  input: UpdateMemberInput,
): Promise<Member> {
  assertMemberAdmin(actor);
  const existing = await prisma.member.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Member not found");

  if (input.status === MemberStatus.WITHDRAWN && actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Only COOP_ADMIN can mark a member WITHDRAWN after board review");
  }

  return prisma.member.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.email !== undefined ? { email: input.email.trim().toLowerCase() } : {}),
      ...(input.phone !== undefined ? { phone: input.phone.trim() } : {}),
      ...(input.mailingAddress !== undefined
        ? { mailingAddress: input.mailingAddress.trim() }
        : {}),
      ...(input.householdPrimaryMemberId !== undefined
        ? { householdPrimaryMemberId: input.householdPrimaryMemberId }
        : {}),
      ...(input.isEligibleToVote !== undefined
        ? { isEligibleToVote: input.isEligibleToVote }
        : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.taxIdLast4 !== undefined
        ? {
            taxIdLast4: input.taxIdLast4
              ? encryptTaxIdLast4(input.taxIdLast4.trim().slice(-4))
              : null,
          }
        : {}),
    },
    include: memberInclude,
  });
}

/**
 * Approves a PENDING member application → ACTIVE.
 * Does not invent capital; investments are recorded separately via recordCapitalInvestment.
 * Confirming the joining MembershipFee is a separate step (confirmMembershipFee).
 */
export async function approveMember(
  memberId: string,
  approvedByUserId: string,
): Promise<Member> {
  const existing = await prisma.member.findUnique({ where: { id: memberId } });
  if (!existing) throw new AppError(404, "Member not found");
  if (existing.status !== MemberStatus.PENDING) {
    throw new AppError(409, "Only PENDING members can be approved to ACTIVE", {
      status: existing.status,
    });
  }

  const approver = await prisma.user.findUnique({
    where: { id: approvedByUserId },
    select: { id: true },
  });
  if (!approver) throw new AppError(400, "approvedByUserId is not a valid user");

  const member = await prisma.member.update({
    where: { id: memberId },
    data: {
      status: MemberStatus.ACTIVE,
      approvedByUserId,
      approvedAt: new Date(),
      isEligibleToVote: true,
    },
    include: memberInclude,
  });

  await writeAuditLog({
    userId: approvedByUserId,
    action: AuditAction.MEMBER_APPROVE,
    entityType: "Member",
    entityId: memberId,
    before: { status: existing.status },
    after: { status: member.status, approvedByUserId },
  });

  return member;
}

/**
 * Confirms receipt of the one-time joining fee. Confers NO voting rights.
 */
export async function confirmMembershipFee(
  actor: AuthUser,
  feeId: string,
  input?: { paymentMethod?: string; paymentReference?: string },
): Promise<MembershipFee> {
  assertCoopAdmin(actor);
  const existing = await prisma.membershipFee.findUnique({ where: { id: feeId } });
  if (!existing) throw new AppError(404, "Membership fee not found");
  if (existing.paymentStatus === MembershipFeeStatus.CONFIRMED) return existing;

  const updated = await prisma.membershipFee.update({
    where: { id: feeId },
    data: {
      paymentStatus: MembershipFeeStatus.CONFIRMED,
      paidAt: new Date(),
      confirmedByUserId: actor.id,
      confirmedAt: new Date(),
      ...(input?.paymentMethod !== undefined
        ? { paymentMethod: input.paymentMethod.trim() }
        : {}),
      ...(input?.paymentReference !== undefined
        ? { paymentReference: input.paymentReference }
        : {}),
    },
  });

  await writeAuditLog({
    userId: actor.id,
    action: AuditAction.MEMBER_APPROVE,
    entityType: "MembershipFee",
    entityId: feeId,
    after: {
      paymentStatus: updated.paymentStatus,
      note: "Joining fee CONFIRMED — confers NO voting rights",
    },
  });

  return updated;
}

/**
 * Creates a withdrawal request for board review (soft status change only).
 * Members are NEVER hard-deleted.
 */
export async function requestWithdrawal(
  memberId: string,
  reason: string,
): Promise<Member> {
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    throw new AppError(400, "Withdrawal reason is required for board review");
  }

  const existing = await prisma.member.findUnique({ where: { id: memberId } });
  if (!existing) throw new AppError(404, "Member not found");
  if (existing.status === MemberStatus.WITHDRAWN) {
    throw new AppError(409, "Member is already WITHDRAWN");
  }
  if (existing.status === MemberStatus.SUSPENDED) {
    throw new AppError(409, "Withdrawal request already pending board review");
  }

  const member = await prisma.member.update({
    where: { id: memberId },
    data: {
      status: MemberStatus.SUSPENDED,
      isEligibleToVote: false,
    },
    include: memberInclude,
  });

  await writeAuditLog({
    userId: null,
    action: AuditAction.MEMBER_WITHDRAW_REQUEST,
    entityType: "Member",
    entityId: memberId,
    before: { status: existing.status },
    after: {
      status: member.status,
      reason: trimmedReason,
      note: "Awaiting board review / capital refund per bylaws — do not hard-delete",
    },
  });

  return member;
}

export async function getPurchaseHistory(memberId: string, page: number, pageSize: number) {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    include: memberInclude,
  });
  if (!member) throw new AppError(404, "Member not found");

  const where = { memberId };
  const skip = (page - 1) * pageSize;
  const [total, sales] = await prisma.$transaction([
    prisma.sale.count({ where }),
    prisma.sale.findMany({
      where,
      include: {
        items: true,
        store: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: pageSize,
    }),
  ]);

  return {
    member,
    sales,
    page,
    pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  };
}

// ─── Capital investments (EQUITY — never createSale / settlement) ────────────

/**
 * Records a verified capital investment and refreshes equity + voting rights.
 *
 * EQUITY — never revenue, never part of store sales or operator settlement.
 * Amount is VARIABLE (a $1,000 minimum for voting; someone may invest $5,000).
 * Additional investments ADD rows; never replace prior investments.
 *
 * @deprecated Prefer recordCapitalInvestment — kept as alias for older callers.
 */
export async function recordCapitalContribution(
  memberId: string,
  amount: number,
  stripePaymentIntentId?: string | null,
): Promise<CapitalInvestment> {
  return recordCapitalInvestment(memberId, amount, {
    stripePaymentIntentId,
    confirm: true,
  });
}

/**
 * Records a capital investment (equity stake).
 * When confirm=true (default for verified payments), status is CONFIRMED and
 * voting rights are recomputed. Unconfirmed PENDING investments do NOT grant votes.
 */
export async function recordCapitalInvestment(
  memberId: string,
  amount: number,
  options?: {
    stripePaymentIntentId?: string | null;
    paymentMethod?: string;
    paymentReference?: string | null;
    subscriptionAgreementUrl?: string | null;
    confirmedByUserId?: string | null;
    /** When false, leave PENDING (no voting rights until confirmed). Default true. */
    confirm?: boolean;
  },
): Promise<CapitalInvestment> {
  if (!(amount > 0)) throw new AppError(400, "Investment amount must be positive");

  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) throw new AppError(404, "Member not found");

  const confirm = options?.confirm !== false;

  const investment = await prisma.$transaction(async (tx) => {
    const certificateNumber = confirm ? await nextCertificateNumber(tx) : null;
    const row = await tx.capitalInvestment.create({
      data: {
        memberId,
        amount: money(amount),
        paymentMethod:
          options?.paymentMethod?.trim() ?? (options?.stripePaymentIntentId ? "card" : ""),
        paymentReference: options?.paymentReference ?? null,
        paymentStatus: confirm
          ? CapitalPaymentStatus.CONFIRMED
          : CapitalPaymentStatus.PENDING,
        stripePaymentIntentId: options?.stripePaymentIntentId ?? null,
        confirmedByUserId: confirm ? (options?.confirmedByUserId ?? null) : null,
        subscriptionAgreementUrl: options?.subscriptionAgreementUrl ?? null,
        receivedAt: confirm ? new Date() : null,
        certificateNumber,
      },
    });
    if (confirm) {
      await refreshEquityAccount(tx, memberId);
    }
    return row;
  });

  await writeAuditLog({
    userId: options?.confirmedByUserId ?? null,
    action: AuditAction.CAPITAL_CONTRIBUTION,
    entityType: "CapitalInvestment",
    entityId: investment.id,
    after: {
      memberId,
      amount: money(amount).toFixed(2),
      paymentStatus: investment.paymentStatus,
      certificateNumber: investment.certificateNumber,
      note: "EQUITY — excluded from sales/settlement/P&L; operator earns 0%",
    },
  });

  return investment;
}

/**
 * Returns the member's equity snapshot: investment history, totals, dividends, balance.
 */
export async function getMemberEquity(memberId: string): Promise<{
  memberId: string;
  investments: CapitalInvestment[];
  /** @deprecated alias of investments */
  contributions: CapitalInvestment[];
  totalContributed: Prisma.Decimal;
  totalInvested: Prisma.Decimal;
  hasVotingRights: boolean;
  dividendsReceived: Array<{
    id: string;
    dividendId: string;
    amount: Prisma.Decimal;
    paymentStatus: CapitalPaymentStatus;
    taxFormIssued: boolean;
  }>;
  dividendsReceivedTotal: Prisma.Decimal;
  currentBalance: Prisma.Decimal;
  equityAccount: {
    totalContributed: Prisma.Decimal;
    distributedToDate: Prisma.Decimal;
    currentBalance: Prisma.Decimal;
    lastUpdatedAt: Date;
  } | null;
}> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    include: {
      equityAccount: true,
      investments: { orderBy: { createdAt: "asc" } },
      dividendAllocations: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          dividendId: true,
          amount: true,
          paymentStatus: true,
          taxFormIssued: true,
        },
      },
    },
  });
  if (!member) throw new AppError(404, "Member not found");

  const dividendsReceivedTotal = money(
    member.dividendAllocations.reduce(
      (sum, row) => sum.add(row.amount),
      new Prisma.Decimal(0),
    ),
  );

  return {
    memberId,
    investments: member.investments,
    contributions: member.investments,
    totalContributed: money(member.equityAccount?.totalContributed ?? 0),
    totalInvested: money(member.totalInvested),
    hasVotingRights: member.hasVotingRights,
    dividendsReceived: member.dividendAllocations,
    dividendsReceivedTotal,
    currentBalance: money(member.equityAccount?.currentBalance ?? 0),
    equityAccount: member.equityAccount
      ? {
          totalContributed: member.equityAccount.totalContributed,
          distributedToDate: member.equityAccount.distributedToDate,
          currentBalance: member.equityAccount.currentBalance,
          lastUpdatedAt: member.equityAccount.lastUpdatedAt,
        }
      : null,
  };
}

export async function markInvestmentConfirmed(
  actor: AuthUser,
  investmentId: string,
  ipAddress?: string | null,
): Promise<CapitalInvestment> {
  assertCoopAdmin(actor);
  const existing = await prisma.capitalInvestment.findUnique({
    where: { id: investmentId },
  });
  if (!existing) throw new AppError(404, "Investment not found");
  if (existing.paymentStatus === CapitalPaymentStatus.CONFIRMED) return existing;

  const updated = await prisma.$transaction(async (tx) => {
    const certificateNumber =
      existing.certificateNumber ?? (await nextCertificateNumber(tx));
    const row = await tx.capitalInvestment.update({
      where: { id: investmentId },
      data: {
        paymentStatus: CapitalPaymentStatus.CONFIRMED,
        receivedAt: new Date(),
        certificateNumber,
        confirmedByUserId: actor.id,
      },
    });
    await refreshEquityAccount(tx, existing.memberId);
    return row;
  });

  await writeAuditLog({
    userId: actor.id,
    action: AuditAction.CAPITAL_CONTRIBUTION,
    entityType: "CapitalInvestment",
    entityId: investmentId,
    before: { paymentStatus: existing.paymentStatus },
    after: {
      paymentStatus: updated.paymentStatus,
      certificateNumber: updated.certificateNumber,
    },
    ipAddress: ipAddress ?? null,
  });

  return updated;
}

/** @deprecated Prefer markInvestmentConfirmed */
export async function markContributionPaid(
  actor: AuthUser,
  contributionId: string,
  ipAddress?: string | null,
): Promise<CapitalInvestment> {
  return markInvestmentConfirmed(actor, contributionId, ipAddress);
}

/** Refunds CONFIRMED capital after board-approved withdrawal — preserves the row. */
export async function refundCapitalInvestment(
  actor: AuthUser,
  investmentId: string,
  ipAddress?: string | null,
): Promise<CapitalInvestment> {
  assertCoopAdmin(actor);
  const existing = await prisma.capitalInvestment.findUnique({
    where: { id: investmentId },
  });
  if (!existing) throw new AppError(404, "Investment not found");
  if (existing.paymentStatus !== CapitalPaymentStatus.CONFIRMED || existing.refundedAt) {
    throw new AppError(409, "Only CONFIRMED, non-refunded investments can be refunded");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.capitalInvestment.update({
      where: { id: investmentId },
      data: {
        paymentStatus: CapitalPaymentStatus.REFUNDED,
        refundedAt: new Date(),
      },
    });
    await refreshEquityAccount(tx, existing.memberId);
    return row;
  });

  await writeAuditLog({
    userId: actor.id,
    action: AuditAction.CAPITAL_REFUND,
    entityType: "CapitalInvestment",
    entityId: investmentId,
    after: { paymentStatus: updated.paymentStatus, refundedAt: updated.refundedAt },
    ipAddress: ipAddress ?? null,
  });

  return updated;
}

/** @deprecated Prefer refundCapitalInvestment */
export async function refundCapitalContribution(
  actor: AuthUser,
  contributionId: string,
  ipAddress?: string | null,
): Promise<CapitalInvestment> {
  return refundCapitalInvestment(actor, contributionId, ipAddress);
}

export async function finalizeWithdrawal(
  actor: AuthUser,
  memberId: string,
  ipAddress?: string | null,
): Promise<Member> {
  assertCoopAdmin(actor);
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    include: { investments: true },
  });
  if (!member) throw new AppError(404, "Member not found");

  const openConfirmed = member.investments.filter(
    (c) => c.paymentStatus === CapitalPaymentStatus.CONFIRMED && !c.refundedAt,
  );
  if (openConfirmed.length) {
    throw new AppError(
      409,
      "Refund all confirmed capital investments before finalizing WITHDRAWN status",
      { openInvestmentIds: openConfirmed.map((c) => c.id) },
    );
  }

  const updated = await prisma.member.update({
    where: { id: memberId },
    data: {
      status: MemberStatus.WITHDRAWN,
      isEligibleToVote: false,
      hasVotingRights: false,
    },
    include: memberInclude,
  });

  await writeAuditLog({
    userId: actor.id,
    action: AuditAction.MEMBER_WITHDRAW_FINALIZE,
    entityType: "Member",
    entityId: memberId,
    after: { status: updated.status },
    ipAddress: ipAddress ?? null,
  });

  return updated;
}

// ─── Board + dividends ───────────────────────────────────────────────────────

export async function createBoardResolution(
  actor: AuthUser,
  input: { title: string; description?: string; minutesUrl?: string },
): Promise<BoardResolution> {
  assertCoopAdmin(actor);
  return prisma.boardResolution.create({
    data: {
      title: input.title.trim(),
      description: input.description?.trim() ?? "",
      minutesUrl: input.minutesUrl ?? null,
    },
  });
}

export async function passBoardResolution(
  actor: AuthUser,
  id: string,
): Promise<BoardResolution> {
  assertCoopAdmin(actor);
  return prisma.boardResolution.update({
    where: { id },
    data: { outcome: BoardResolutionOutcome.PASSED, votedAt: new Date() },
  });
}

/**
 * Declares a dividend pool tied to a board resolution.
 * allocationMethod is stored so allocateDividend can split later —
 * callers must never hardcode BY_CAPITAL as the only formula.
 */
export async function declareDividend(
  boardResolutionId: string,
  fiscalYear: number,
  totalPoolAmount: number,
  allocationMethod: DividendAllocationMethod,
): Promise<Dividend> {
  const resolution = await prisma.boardResolution.findUnique({
    where: { id: boardResolutionId },
  });
  if (!resolution) {
    throw new AppError(404, "Board resolution not found");
  }
  if (resolution.outcome !== BoardResolutionOutcome.PASSED) {
    throw new AppError(
      400,
      "Dividend requires a BoardResolution whose outcome is PASSED (approved)",
      { outcome: resolution.outcome },
    );
  }
  if (!(totalPoolAmount > 0)) {
    throw new AppError(400, "totalPoolAmount must be positive");
  }
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1900) {
    throw new AppError(400, "fiscalYear must be a valid calendar year");
  }

  return prisma.dividend.create({
    data: {
      boardResolutionId,
      fiscalYear,
      totalPoolAmount: money(totalPoolAmount),
      allocationMethod,
      status: DividendStatus.DECLARED,
    },
  });
}

function fiscalYearBounds(fiscalYear: number): { start: Date; endExclusive: Date } {
  return {
    start: new Date(Date.UTC(fiscalYear, 0, 1, 0, 0, 0, 0)),
    endExclusive: new Date(Date.UTC(fiscalYear + 1, 0, 1, 0, 0, 0, 0)),
  };
}

const DEFAULT_HYBRID_CAPITAL_SHARE = 0.5;

/**
 * Splits a declared dividend pool across ACTIVE members into DividendAllocation rows.
 *
 * - BY_CAPITAL: proportional to each member's totalInvested (CONFIRMED capital)
 * - BY_PATRONAGE: proportional to each member's purchases (sale subtotals) in that fiscal year
 * - HYBRID: configurable blend of the two after independent normalization
 *
 * Voting is NEVER weighted by any of this.
 */
export async function allocateDividend(
  dividendId: string,
  options?: { hybridCapitalShare?: number },
): Promise<Dividend> {
  const dividend = await prisma.dividend.findUnique({ where: { id: dividendId } });
  if (!dividend) throw new AppError(404, "Dividend not found");
  if (dividend.status !== DividendStatus.DECLARED) {
    throw new AppError(409, "Dividend already allocated or closed");
  }

  const members = await prisma.member.findMany({
    where: { status: MemberStatus.ACTIVE },
  });

  const { start, endExclusive } = fiscalYearBounds(dividend.fiscalYear);
  const patronageRows = await prisma.sale.groupBy({
    by: ["memberId"],
    where: {
      memberId: { not: null },
      createdAt: { gte: start, lt: endExclusive },
      paymentStatus: { in: ["PAID", "REFUNDED", "REFUNDING"] },
    },
    _sum: { subtotal: true },
  });
  const patronageByMember = new Map(
    patronageRows.map((r) => [r.memberId!, Number(r._sum.subtotal ?? 0)]),
  );

  // BY_CAPITAL uses Member.totalInvested (rollup of CONFIRMED CapitalInvestment only).
  const capitalByMember = new Map(members.map((m) => [m.id, Number(m.totalInvested)]));

  const capitalShareRaw = options?.hybridCapitalShare ?? DEFAULT_HYBRID_CAPITAL_SHARE;
  if (capitalShareRaw < 0 || capitalShareRaw > 1) {
    throw new AppError(400, "hybridCapitalShare must be between 0 and 1");
  }

  const totalCapital = [...capitalByMember.values()].reduce((s, v) => s + v, 0);
  const totalPatronage = [...patronageByMember.values()].reduce((s, v) => s + v, 0);

  type WeightRow = { memberId: string; weight: Prisma.Decimal };
  const weights: WeightRow[] = [];

  for (const m of members) {
    const capital = capitalByMember.get(m.id) ?? 0;
    const patronage = patronageByMember.get(m.id) ?? 0;
    let weight = 0;

    if (dividend.allocationMethod === DividendAllocationMethod.BY_CAPITAL) {
      weight = capital;
    } else if (dividend.allocationMethod === DividendAllocationMethod.BY_PATRONAGE) {
      weight = patronage;
    } else {
      const capitalNorm = totalCapital > 0 ? capital / totalCapital : 0;
      const patronageNorm = totalPatronage > 0 ? patronage / totalPatronage : 0;
      weight =
        capitalShareRaw * capitalNorm + (1 - capitalShareRaw) * patronageNorm;
    }

    if (weight > 0) {
      weights.push({ memberId: m.id, weight: new Prisma.Decimal(weight) });
    }
  }

  const totalWeight = weights.reduce((s, w) => s.add(w.weight), new Prisma.Decimal(0));
  if (totalWeight.lte(0)) {
    throw new AppError(400, "No members have positive weight for this allocation method");
  }

  await prisma.$transaction(async (tx) => {
    await tx.dividendAllocation.deleteMany({ where: { dividendId } });
    for (const w of weights) {
      const amount = money(dividend.totalPoolAmount.mul(w.weight).div(totalWeight));
      await tx.dividendAllocation.create({
        data: {
          dividendId,
          memberId: w.memberId,
          memberWeight: w.weight,
          amount,
          paymentStatus: CapitalPaymentStatus.PENDING,
          taxFormIssued: false,
        },
      });
    }
    await tx.dividend.update({
      where: { id: dividendId },
      data: { status: DividendStatus.ALLOCATED },
    });
  });

  return prisma.dividend.findUniqueOrThrow({
    where: { id: dividendId },
    include: { allocations: true },
  });
}

// ─── Ballots (one member, one vote AMONG MEMBERS WITH VOTING RIGHTS) ─────────

export async function createBallot(
  actor: AuthUser,
  input: { title: string; description?: string; options: string[] },
): Promise<Ballot> {
  assertCoopAdmin(actor);
  if (!input.options?.length) throw new AppError(400, "Ballot needs at least one option");
  return prisma.ballot.create({
    data: {
      title: input.title.trim(),
      description: input.description?.trim() ?? "",
      options: {
        create: input.options.map((label, i) => ({
          label: label.trim(),
          sortOrder: i,
        })),
      },
    },
    include: { options: true },
  });
}

/**
 * Casts a vote.
 *
 * /// A member votes ONLY if totalInvested >= CooperativeSettings.votingThresholdAmount.
 * /// Above the threshold every voting member gets EXACTLY ONE vote, whether they invested $1,000
 * /// or $50,000. Investing more buys more dividend participation, never more votes.
 * /// One member, one vote AMONG MEMBERS WITH VOTING RIGHTS.
 *
 * DB @@unique([ballotId, memberId]) + hasVotingRights service check.
 */
export async function castVote(input: {
  ballotId: string;
  memberId: string;
  ballotOptionId: string;
}) {
  const ballot = await prisma.ballot.findUnique({
    where: { id: input.ballotId },
    include: { options: true },
  });
  if (!ballot || ballot.status !== BallotStatus.OPEN) {
    throw new AppError(409, "Ballot is not open for voting");
  }
  if (ballot.closesAt && ballot.closesAt.getTime() < Date.now()) {
    throw new AppError(409, "Ballot voting period has ended");
  }

  const member = await prisma.member.findUnique({ where: { id: input.memberId } });
  if (!member) throw new AppError(404, "Member not found");

  if (member.status !== MemberStatus.ACTIVE || !member.isEligibleToVote) {
    throw new AppError(403, "Member is not eligible to vote");
  }
  // Service-level check: joining fee alone is never enough — need hasVotingRights.
  if (!member.hasVotingRights) {
    throw new AppError(
      403,
      "Member does not have voting rights (capital investment below threshold)",
      {
        totalInvested: member.totalInvested.toFixed(2),
        hasVotingRights: false,
      },
    );
  }
  if (!ballot.options.some((o) => o.id === input.ballotOptionId)) {
    throw new AppError(400, "Option is not on this ballot");
  }

  try {
    return await prisma.memberVote.create({
      data: {
        ballotId: input.ballotId,
        memberId: input.memberId,
        ballotOptionId: input.ballotOptionId,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(409, "Member has already voted on this ballot");
    }
    throw error;
  }
}
