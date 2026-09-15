/**
 * Factories for money-path tests — store, users, products, members.
 */
import { MemberStatus, Prisma, Role, type Member, type Product, type Store, type User } from "@prisma/client";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prisma } from "./db.js";
import type { AuthUser } from "../../src/types/auth.js";

export async function createStore(input?: {
  name?: string;
  operatorPercent?: number;
  isActive?: boolean;
}): Promise<Store> {
  return prisma.store.create({
    data: {
      name: input?.name ?? "Test Store",
      address: "1 Test Lane",
      operatorPercent: new Prisma.Decimal(input?.operatorPercent ?? 10),
      isActive: input?.isActive ?? true,
    },
  });
}

export async function createUser(input: {
  email: string;
  role: Role;
  storeId?: string | null;
  password?: string;
}): Promise<User> {
  return prisma.user.create({
    data: {
      email: input.email,
      passwordHash: await bcrypt.hash(input.password ?? "TestPassword123!", 4),
      role: input.role,
      storeId: input.storeId ?? null,
      mustChangePassword: false,
    },
  });
}

export async function createProduct(
  storeId: string,
  input?: Partial<{
    sku: string;
    name: string;
    price: number;
    cost: number;
    stock: number;
    reserved: number;
    reorderAt: number;
  }>,
): Promise<Product> {
  return prisma.product.create({
    data: {
      storeId,
      sku: input?.sku ?? `SKU-${Math.random().toString(36).slice(2, 8)}`,
      name: input?.name ?? "Test Product",
      category: "Test",
      price: new Prisma.Decimal(input?.price ?? 10),
      cost: new Prisma.Decimal(input?.cost ?? 4),
      stock: input?.stock ?? 10,
      reserved: input?.reserved ?? 0,
      reorderAt: input?.reorderAt ?? 2,
    },
  });
}

export async function createMember(input?: {
  status?: MemberStatus;
  email?: string;
  hasVotingRights?: boolean;
  totalInvested?: number;
}): Promise<Member> {
  const status = input?.status ?? MemberStatus.ACTIVE;
  const member = await prisma.member.create({
    data: {
      memberNumber: `M${Math.floor(Math.random() * 1_000_000)}`,
      name: "Test Member",
      email: input?.email ?? `member-${Date.now()}@test.local`,
      status,
      isEligibleToVote: status === MemberStatus.ACTIVE,
      hasVotingRights: input?.hasVotingRights ?? false,
      totalInvested: new Prisma.Decimal(input?.totalInvested ?? 0),
      approvedAt: new Date(),
    },
  });
  await prisma.memberEquityAccount.create({
    data: { memberId: member.id },
  });
  return member;
}

export function asAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    storeId: user.storeId,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  };
}

export function signTestToken(user: User): string {
  return jwt.sign(
    {
      storeId: user.storeId,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    },
    process.env.JWT_SECRET ?? "test-jwt-secret-harvestlink-ci",
    { subject: user.id, expiresIn: "1h" },
  );
}

export async function seedCashierStore(): Promise<{
  store: Store;
  cashier: User;
  storeAdmin: User;
  coopAdmin: User;
}> {
  const store = await createStore({ operatorPercent: 10 });
  const cashier = await createUser({
    email: `cashier-${Date.now()}@test.local`,
    role: Role.CASHIER,
    storeId: store.id,
  });
  const storeAdmin = await createUser({
    email: `storeadmin-${Date.now()}@test.local`,
    role: Role.STORE_ADMIN,
    storeId: store.id,
  });
  const coopAdmin = await createUser({
    email: `coop-${Date.now()}@test.local`,
    role: Role.COOP_ADMIN,
    storeId: null,
  });
  return { store, cashier, storeAdmin, coopAdmin };
}
