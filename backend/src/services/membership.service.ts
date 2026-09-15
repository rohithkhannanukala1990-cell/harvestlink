/**
 * Co-op membership & equity — Harvestlink members are OWNERS, not subscribers.
 *
 * HARD RULES (do not violate):
 * 1. Capital contributions NEVER flow through createSale or settlement. Operators earn
 *    NO percentage on them. All equity payment paths live in THIS service only.
 * 2. Contributions are EQUITY — excluded from sales revenue, store revenue, operator
 *    settlement, and P&L reporting.
 * 3. One member, one vote. Enforced by @@unique([ballotId, memberId]) AND checks here.
 *    Never weight a vote by contribution size.
 * 4. A Dividend cannot be created without a BoardResolution.
 * 5. Members are never hard-deleted. Withdrawal = status change + refund flow.
 * 6. taxIdLast4 is stored encrypted for dividend tax forms (1099-PATR vs 1099-DIV —
 *    classification must be confirmed with the co-op's accountant before issuing).
 *
 * Memberships NEVER expire. POS validates status === ACTIVE only.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  BallotStatus,
  BoardResolutionOutcome,
  CapitalPaymentStatus,
  DividendAllocationMethod,
  DividendStatus,
  MemberStatus,
  Prisma,
  Role,
  type Ballot,
  type BoardResolution,
  type CapitalContribution,
  type Dividend,
  type Member,
  type MembershipClass,
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

/**
 * Recomputes MemberEquityAccount from PAID capital − refunded + dividend distributions.
 * Equity math is intentionally separate from Sale / settlement pipelines.
 */
async function refreshEquityAccount(
  tx: Prisma.TransactionClient,
  memberId: string,
): Promise<void> {
  const paid = await tx.capitalContribution.aggregate({
    where: {
      memberId,
      paymentStatus: CapitalPaymentStatus.PAID,
      refundedAt: null,
    },
    _sum: { amount: true },
  });
  const distributed = await tx.dividendAllocation.aggregate({
    where: {
      memberId,
      paymentStatus: CapitalPaymentStatus.PAID,
    },
    _sum: { amount: true },
  });
  const totalContributed = money(paid._sum.amount ?? 0);
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
}

// ─── Membership classes ──────────────────────────────────────────────────────

export async function listMembershipClasses(activeOnly = false): Promise<MembershipClass[]> {
  return prisma.membershipClass.findMany({
    where: activeOnly ? { isActive: true } : undefined,
    orderBy: { contributionAmount: "asc" },
  });
}

export async function createMembershipClass(
  actor: AuthUser,
  input: {
    name: string;
    contributionAmount: number;
    dividendWeight?: number;
    description?: string;
  },
): Promise<MembershipClass> {
  assertCoopAdmin(actor);
  // votingRights is ALWAYS 1 — one-member-one-vote is data, not an assumption.
  return prisma.membershipClass.create({
    data: {
      name: input.name.trim(),
      contributionAmount: money(input.contributionAmount),
      votingRights: 1,
      dividendWeight: money(input.dividendWeight ?? input.contributionAmount),
      description: input.description?.trim() ?? "",
    },
  });
}

// ─── Members ─────────────────────────────────────────────────────────────────

export type CreateMemberInput = {
  name: string;
  email: string;
  phone?: string;
  mailingAddress?: string;
  membershipClassId: string;
  taxIdLast4?: string;
  householdPrimaryMemberId?: string | null;
  /** When true, create as ACTIVE immediately (admin onboarding). Default PENDING. */
  activate?: boolean;
};

export type UpdateMemberInput = Partial<{
  name: string;
  email: string;
  phone: string;
  mailingAddress: string;
  membershipClassId: string;
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
  membershipClass: true,
  equityAccount: true,
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
  const klass = await prisma.membershipClass.findUnique({
    where: { id: input.membershipClassId },
  });
  if (!klass || !klass.isActive) {
    throw new AppError(400, "Membership class not found or inactive");
  }
  if (klass.votingRights !== 1) {
    throw new AppError(500, "Invalid membership class: votingRights must be 1");
  }

  const activate = Boolean(input.activate);
  const taxEnc = input.taxIdLast4?.trim()
    ? encryptTaxIdLast4(input.taxIdLast4.trim().slice(-4))
    : null;

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
            membershipClassId: input.membershipClassId,
            status: activate ? MemberStatus.ACTIVE : MemberStatus.PENDING,
            approvedByUserId: activate ? actor.id : null,
            approvedAt: activate ? new Date() : null,
            taxIdLast4: taxEnc,
            isEligibleToVote: activate,
            householdPrimaryMemberId: input.householdPrimaryMemberId ?? null,
          },
          include: memberInclude,
        });
        await tx.memberEquityAccount.create({
          data: { memberId: member.id },
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
export function assertMemberActiveForSale(member: { status: MemberStatus; memberNumber: string }): void {
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

  // Never hard-delete; status transitions only.
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
      ...(input.membershipClassId !== undefined
        ? { membershipClassId: input.membershipClassId }
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
 *
 * Sets approvedByUserId / approvedAt and restores voting eligibility.
 * Memberships do NOT expire — ACTIVE is the only POS gate (no expiresAt).
 * Does not invent capital; contributions are recorded separately via
 * recordCapitalContribution after payment is verified.
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
 * Creates a withdrawal request for board review (soft status change only).
 *
 * /// Members are NEVER hard-deleted. Their financial history must survive permanently. Withdrawal
 * /// is: request, then board review, then refund of capital subject to the bylaws.
 *
 * Flow after this call:
 * 1. Board reviews the reason (stored on the audit row).
 * 2. COOP_ADMIN refunds PAID CapitalContribution rows (refundCapitalContribution).
 * 3. finalizeWithdrawal marks the member WITHDRAWN once capital is cleared.
 *
 * The member is SUSPENDED (not deleted) so POS stops attaching them and voting stops,
 * while CapitalContribution / DividendAllocation / Sale history remain intact.
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

  // Soft-flag via SUSPENDED pending board; never DELETE the Member row.
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

// ─── Capital contributions (EQUITY — never createSale / settlement) ──────────

/**
 * Records a verified capital contribution and refreshes the member equity ledger
 * in a single transaction. Always issues a certificateNumber for the paid stake.
 *
 * /// CRITICAL: This is EQUITY, not revenue. This function must NEVER call createSale, must never
 * /// touch the settlement pipeline, and the store operator earns NO percentage on it. A member
 * /// contributing capital is buying ownership, not buying groceries.
 *
 * Upgrading $100 → $1,000 ADDS a new CapitalContribution row; it never replaces prior rows.
 * Dividend weight uses TOTAL contributed capital; voting stays one-member-one-vote.
 *
 * @param memberId Owner receiving the equity credit
 * @param amount USD amount of this buy-in (must be positive)
 * @param stripePaymentIntentId Optional Stripe PI when card-collected; cash/check omit this
 */
export async function recordCapitalContribution(
  memberId: string,
  amount: number,
  stripePaymentIntentId?: string | null,
): Promise<CapitalContribution> {
  if (!(amount > 0)) throw new AppError(400, "Contribution amount must be positive");

  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) throw new AppError(404, "Member not found");

  // Single transaction: CapitalContribution (PAID) + MemberEquityAccount recompute.
  // Intentionally does NOT import or call sales.service / settlement / createSale.
  const contribution = await prisma.$transaction(async (tx) => {
    const certificateNumber = await nextCertificateNumber(tx);
    const row = await tx.capitalContribution.create({
      data: {
        memberId,
        amount: money(amount),
        paymentStatus: CapitalPaymentStatus.PAID,
        stripePaymentIntentId: stripePaymentIntentId ?? null,
        receivedAt: new Date(),
        certificateNumber,
      },
    });
    await refreshEquityAccount(tx, memberId);
    return row;
  });

  await writeAuditLog({
    userId: null,
    action: AuditAction.CAPITAL_CONTRIBUTION,
    entityType: "CapitalContribution",
    entityId: contribution.id,
    after: {
      memberId,
      amount: money(amount).toFixed(2),
      paymentStatus: contribution.paymentStatus,
      certificateNumber: contribution.certificateNumber,
      stripePaymentIntentId: stripePaymentIntentId ?? null,
      note: "EQUITY — excluded from sales/settlement/P&L; operator earns 0%",
    },
  });

  return contribution;
}

/**
 * Returns the member's equity snapshot: contribution history, totals, dividends, balance.
 * Reads MemberEquityAccount (ledger) plus related CapitalContribution / DividendAllocation rows.
 * Never invents capital — legacy members migrated without payment show zero until recorded.
 */
export async function getMemberEquity(memberId: string): Promise<{
  memberId: string;
  contributions: CapitalContribution[];
  totalContributed: Prisma.Decimal;
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
      contributions: { orderBy: { createdAt: "asc" } },
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
    contributions: member.contributions,
    totalContributed: money(member.equityAccount?.totalContributed ?? 0),
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

export async function markContributionPaid(
  actor: AuthUser,
  contributionId: string,
  ipAddress?: string | null,
): Promise<CapitalContribution> {
  assertCoopAdmin(actor);
  const existing = await prisma.capitalContribution.findUnique({
    where: { id: contributionId },
  });
  if (!existing) throw new AppError(404, "Contribution not found");
  if (existing.paymentStatus === CapitalPaymentStatus.PAID) return existing;

  const updated = await prisma.$transaction(async (tx) => {
    const certificateNumber =
      existing.certificateNumber ?? (await nextCertificateNumber(tx));
    const row = await tx.capitalContribution.update({
      where: { id: contributionId },
      data: {
        paymentStatus: CapitalPaymentStatus.PAID,
        receivedAt: new Date(),
        certificateNumber,
      },
    });
    await refreshEquityAccount(tx, existing.memberId);
    return row;
  });

  await writeAuditLog({
    userId: actor.id,
    action: AuditAction.CAPITAL_CONTRIBUTION,
    entityType: "CapitalContribution",
    entityId: contributionId,
    before: { paymentStatus: existing.paymentStatus },
    after: { paymentStatus: updated.paymentStatus, certificateNumber: updated.certificateNumber },
    ipAddress: ipAddress ?? null,
  });

  return updated;
}

/** Refunds PAID capital after board-approved withdrawal — preserves the row (status REFUNDED). */
export async function refundCapitalContribution(
  actor: AuthUser,
  contributionId: string,
  ipAddress?: string | null,
): Promise<CapitalContribution> {
  assertCoopAdmin(actor);
  const existing = await prisma.capitalContribution.findUnique({
    where: { id: contributionId },
  });
  if (!existing) throw new AppError(404, "Contribution not found");
  if (existing.paymentStatus !== CapitalPaymentStatus.PAID || existing.refundedAt) {
    throw new AppError(409, "Only PAID, non-refunded contributions can be refunded");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.capitalContribution.update({
      where: { id: contributionId },
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
    entityType: "CapitalContribution",
    entityId: contributionId,
    after: { paymentStatus: updated.paymentStatus, refundedAt: updated.refundedAt },
    ipAddress: ipAddress ?? null,
  });

  return updated;
}

export async function finalizeWithdrawal(
  actor: AuthUser,
  memberId: string,
  ipAddress?: string | null,
): Promise<Member> {
  assertCoopAdmin(actor);
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    include: { contributions: true },
  });
  if (!member) throw new AppError(404, "Member not found");

  const openPaid = member.contributions.filter(
    (c) => c.paymentStatus === CapitalPaymentStatus.PAID && !c.refundedAt,
  );
  if (openPaid.length) {
    throw new AppError(
      409,
      "Refund all paid capital contributions before finalizing WITHDRAWN status",
      { openContributionIds: openPaid.map((c) => c.id) },
    );
  }

  const updated = await prisma.member.update({
    where: { id: memberId },
    data: {
      status: MemberStatus.WITHDRAWN,
      isEligibleToVote: false,
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
 *
 * /// A Dividend CANNOT be created without a BoardResolution. Reject the call if the resolution
 * /// does not exist or its outcome was not approved. Dividends are a board decision, never an
 * /// admin button.
 *
 * allocationMethod is stored on the Dividend so allocateDividend can split later —
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
  // Only PASSED resolutions authorize a pool — PENDING/FAILED/TABLED are rejected.
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

/** UTC calendar bounds for a fiscal year used in patronage weighting. */
function fiscalYearBounds(fiscalYear: number): { start: Date; endExclusive: Date } {
  return {
    start: new Date(Date.UTC(fiscalYear, 0, 1, 0, 0, 0, 0)),
    endExclusive: new Date(Date.UTC(fiscalYear + 1, 0, 1, 0, 0, 0, 0)),
  };
}

/**
 * Default HYBRID mix: 50% capital / 50% patronage. Override via capitalShare (0..1).
 * Normalized per factor so dollar scales do not dominate each other before blending.
 */
const DEFAULT_HYBRID_CAPITAL_SHARE = 0.5;

/**
 * Splits a declared dividend pool across ACTIVE members into DividendAllocation rows.
 *
 * - BY_CAPITAL: proportional to each member's totalContributed (PAID capital)
 * - BY_PATRONAGE: proportional to each member's purchases (sale subtotals) in that fiscal year
 * - HYBRID: configurable blend of the two after independent normalization
 *
 * /// Voting is NEVER weighted by any of this. One member, one vote, always.
 *
 * Allocation does not pay anyone and does not change voting power. Tax-form flags stay
 * false until ops confirms 1099-PATR vs 1099-DIV with the co-op accountant.
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
    include: { equityAccount: true },
  });

  // Patronage = PRE-TAX sale subtotals attached to the member in the dividend's fiscal year.
  // Not lifetime — bylaws typically allocate patronage for a specific year.
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

  const capitalByMember = new Map(
    members.map((m) => [m.id, Number(m.equityAccount?.totalContributed ?? 0)]),
  );

  const capitalShareRaw = options?.hybridCapitalShare ?? DEFAULT_HYBRID_CAPITAL_SHARE;
  if (capitalShareRaw < 0 || capitalShareRaw > 1) {
    throw new AppError(400, "hybridCapitalShare must be between 0 and 1");
  }

  // Independent totals for normalizing HYBRID factors (avoids $ patronage drowning $ capital).
  const totalCapital = [...capitalByMember.values()].reduce((s, v) => s + v, 0);
  const totalPatronage = [...patronageByMember.values()].reduce((s, v) => s + v, 0);

  type WeightRow = { memberId: string; weight: Prisma.Decimal };
  const weights: WeightRow[] = [];

  for (const m of members) {
    const capital = capitalByMember.get(m.id) ?? 0;
    const patronage = patronageByMember.get(m.id) ?? 0;
    let weight = 0;

    if (dividend.allocationMethod === DividendAllocationMethod.BY_CAPITAL) {
      // Proportional to total contributed capital (equity), not sales.
      weight = capital;
    } else if (dividend.allocationMethod === DividendAllocationMethod.BY_PATRONAGE) {
      // Proportional to that fiscal year's purchases only.
      weight = patronage;
    } else {
      // HYBRID: configurable split between normalized capital and patronage shares.
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
          // taxFormIssued stays false until ops confirms 1099-PATR vs 1099-DIV with accountant
          taxFormIssued: false,
        },
      });
    }
    await tx.dividend.update({
      where: { id: dividendId },
      data: { status: DividendStatus.ALLOCATED },
    });
  });

  // Voting is NEVER derived from these weights — ballots remain one-member-one-vote.
  return prisma.dividend.findUniqueOrThrow({
    where: { id: dividendId },
    include: { allocations: true },
  });
}

// ─── Ballots (one member, one vote) ──────────────────────────────────────────

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
 * Casts a vote. HARD RULE: one vote per ACTIVE eligible member.
 * DB unique (ballotId, memberId) + application checks. Never weight by capital.
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
  // One member, one vote — eligibility is status + flag, NEVER contribution size.
  if (member.status !== MemberStatus.ACTIVE || !member.isEligibleToVote) {
    throw new AppError(403, "Member is not eligible to vote");
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
