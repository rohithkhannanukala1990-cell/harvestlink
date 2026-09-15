/**
 * Database seed for Harvestlink local/dev bootstrap.
 *
 * Creates the first COOP_ADMIN (required before POST /auth/register works) plus a sample
 * store and store-scoped staff so login, role checks, and later POS flows can be exercised
 * without manual SQL. Safe to re-run: existing emails/stores are skipped (upsert-style).
 *
 * Seeded accounts are created with mustChangePassword=true so first login forces a change.
 * Refuses to run with the well-known default passwords when NODE_ENV=production.
 */
import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcrypt";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();
const BCRYPT_ROUNDS = 12;

const DEFAULT_ADMIN_PASSWORD = "ChangeMeAdmin123!";
const DEFAULT_STORE_ADMIN_PASSWORD = "ChangeMeStore123!";
const DEFAULT_CASHIER_PASSWORD = "ChangeMeCashier123!";

const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@harvestlink.local";
const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? DEFAULT_ADMIN_PASSWORD;
const storeAdminEmail = process.env.SEED_STORE_ADMIN_EMAIL ?? "storeadmin@harvestlink.local";
const storeAdminPassword = process.env.SEED_STORE_ADMIN_PASSWORD ?? DEFAULT_STORE_ADMIN_PASSWORD;
const cashierEmail = process.env.SEED_CASHIER_EMAIL ?? "cashier@harvestlink.local";
const cashierPassword = process.env.SEED_CASHIER_PASSWORD ?? DEFAULT_CASHIER_PASSWORD;

const KNOWN_DEFAULT_PASSWORDS = new Set([
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_STORE_ADMIN_PASSWORD,
  DEFAULT_CASHIER_PASSWORD,
]);

function assertProductionSeedSafe(): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  const passwords = [adminPassword, storeAdminPassword, cashierPassword];
  const usingDefault = passwords.some((p) => KNOWN_DEFAULT_PASSWORDS.has(p));
  if (usingDefault) {
    throw new Error(
      "Refusing to seed in production with default passwords. " +
        "Set SEED_*_PASSWORD env vars to unique strong passwords, or do not run seed in production.",
    );
  }
}

async function upsertUser(input: {
  email: string;
  password: string;
  role: Role;
  storeId: string | null;
}) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });

  if (existing) {
    console.log(`Skipping existing user: ${input.email} (${existing.role})`);
    return existing;
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      role: input.role,
      storeId: input.storeId,
      mustChangePassword: true,
    },
  });

  console.log(`Created ${input.role}: ${input.email} (mustChangePassword=true)`);
  return user;
}

async function main() {
  assertProductionSeedSafe();

  let store = await prisma.store.findFirst({
    where: { name: "Harvestlink Demo Store" },
  });

  if (!store) {
    store = await prisma.store.create({
      data: {
        name: "Harvestlink Demo Store",
        address: "100 Co-op Way, Demo City",
        operatorPercent: 10.0,
        isActive: true,
      },
    });
    console.log(`Created store: ${store.name} (${store.id})`);
  } else {
    console.log(`Skipping existing store: ${store.name} (${store.id})`);
  }

  await upsertUser({
    email: adminEmail,
    password: adminPassword,
    role: Role.COOP_ADMIN,
    storeId: null,
  });

  await upsertUser({
    email: storeAdminEmail,
    password: storeAdminPassword,
    role: Role.STORE_ADMIN,
    storeId: store.id,
  });

  await upsertUser({
    email: cashierEmail,
    password: cashierPassword,
    role: Role.CASHIER,
    storeId: store.id,
  });

  console.log("\nSeed complete. Login with:");
  console.log(`  COOP_ADMIN   ${adminEmail} / ${adminPassword}`);
  console.log(`  STORE_ADMIN  ${storeAdminEmail} / ${storeAdminPassword}`);
  console.log(`  CASHIER      ${cashierEmail} / ${cashierPassword}`);
  console.log("Seeded accounts must change password on first login.");
}

main()
  .catch((error) => {
    console.error("Seed failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
