/**
 * Membership business logic for Harvestlink.
 *
 * Members are co-op-wide (not store-scoped): the same memberNumber works at every
 * store's POS. Purchase history therefore spans all stores by design.
 *
 * memberNumber lookups must be fast — cashiers scan/type the number during a live
 * checkout while the lane is waiting. That is why Member.memberNumber is @unique
 * (and @@index) in the Prisma schema: indexed equality lookups beat a full table
 * scan when the co-op has tens of thousands of members.
 */
import { createHash, randomBytes } from "node:crypto";
import { MemberTier, Prisma, type Member, type Sale, type SaleItem } from "@prisma/client";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

export type CreateMemberInput = {
  name: string;
  email: string;
  tier?: MemberTier;
  /** Membership expiration; defaults to one year from join if omitted. */
  expiresAt?: Date;
};

export type UpdateMemberInput = Partial<{
  name: string;
  email: string;
  tier: MemberTier;
  expiresAt: Date;
}>;

export type ListMembersFilter = {
  /** Free-text search matched against name (contains) or memberNumber (contains/equals). */
  q?: string;
  page: number;
  pageSize: number;
};

export type MemberSaleHistory = Sale & {
  items: SaleItem[];
  store: { id: string; name: string };
};

/**
 * Generates a unique co-op-wide member number (e.g. HL-A1B2C3D4).
 * Retries on the rare unique collision so checkout cards always get a usable id.
 */
async function generateUniqueMemberNumber(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `HL-${randomBytes(4).toString("hex").toUpperCase()}`;
    const existing = await prisma.member.findUnique({
      where: { memberNumber: candidate },
      select: { id: true },
    });
    if (!existing) {
      return candidate;
    }
  }

  // Extremely unlikely fallback: hash timestamp entropy into a longer code.
  const fallback = `HL-${createHash("sha1")
    .update(`${Date.now()}-${randomBytes(8).toString("hex")}`)
    .digest("hex")
    .slice(0, 10)
    .toUpperCase()}`;
  return fallback;
}

/**
 * Lists / searches members by name or memberNumber (co-op-wide directory).
 */
export async function listMembers(filter: ListMembersFilter): Promise<{
  members: Member[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}> {
  const q = filter.q?.trim();
  const where: Prisma.MemberWhereInput = q
    ? {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { memberNumber: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      }
    : {};

  const skip = (filter.page - 1) * filter.pageSize;

  const [total, members] = await prisma.$transaction([
    prisma.member.count({ where }),
    prisma.member.findMany({
      where,
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

/**
 * Creates a member and auto-assigns a unique memberNumber for POS card printing.
 */
export async function createMember(input: CreateMemberInput): Promise<Member> {
  const expiresAt =
    input.expiresAt ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  if (expiresAt.getTime() <= Date.now()) {
    throw new AppError(400, "expiresAt must be in the future");
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const memberNumber = await generateUniqueMemberNumber();
    try {
      return await prisma.member.create({
        data: {
          memberNumber,
          name: input.name,
          email: input.email,
          tier: input.tier ?? MemberTier.STANDARD,
          expiresAt,
        },
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
 * POS checkout lookup by membership card number.
 *
 * Hot path: called while a cashier is mid-transaction. Relies on the indexed
 * memberNumber column (@unique / @@index in schema) for a fast equality read
 * instead of scanning the members table.
 */
export async function getMemberByNumber(memberNumber: string): Promise<Member> {
  const member = await prisma.member.findUnique({
    where: { memberNumber },
  });

  if (!member) {
    throw new AppError(404, "Member not found");
  }

  return member;
}

/**
 * Updates member profile / tier fields (not memberNumber — card numbers stay stable).
 */
export async function updateMember(id: string, input: UpdateMemberInput): Promise<Member> {
  const existing = await prisma.member.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError(404, "Member not found");
  }

  if (input.expiresAt && Number.isNaN(input.expiresAt.getTime())) {
    throw new AppError(400, "Invalid expiresAt");
  }

  return prisma.member.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.tier !== undefined ? { tier: input.tier } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    },
  });
}

/**
 * Returns a member's sales across ALL stores (co-op-wide history).
 * Settlement and member-service UIs use this — not limited to the caller's store.
 */
export async function getPurchaseHistory(
  memberId: string,
  page: number,
  pageSize: number,
): Promise<{
  member: Member;
  sales: MemberSaleHistory[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}> {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) {
    throw new AppError(404, "Member not found");
  }

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
