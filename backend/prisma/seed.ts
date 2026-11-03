/**
 * Database seed for Harvestlink local/dev bootstrap.
 *
 * Creates the first COOP_ADMIN (required before POST /auth/register works) plus Houston
 * warehouse + retail store and store-scoped staff so login, role checks, and POS flows can
 * be exercised without manual SQL. Safe to re-run: existing emails/stores are skipped.
 *
 * Seeded accounts are created with mustChangePassword=true so first login forces a change.
 * Refuses to run with the well-known default passwords when NODE_ENV=production.
 */
import { LocationType, PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcrypt";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();
const BCRYPT_ROUNDS = 12;

const DEFAULT_ADMIN_PASSWORD = "ChangeMeAdmin123!";
const DEFAULT_STORE_ADMIN_PASSWORD = "ChangeMeStore123!";
const DEFAULT_CASHIER_PASSWORD = "ChangeMeCashier123!";
const DEFAULT_WAREHOUSE_ADMIN_PASSWORD = "ChangeMeWarehouse123!";

const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@harvestlink.local";
const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? DEFAULT_ADMIN_PASSWORD;
const storeAdminEmail = process.env.SEED_STORE_ADMIN_EMAIL ?? "storeadmin@harvestlink.local";
const storeAdminPassword = process.env.SEED_STORE_ADMIN_PASSWORD ?? DEFAULT_STORE_ADMIN_PASSWORD;
const cashierEmail = process.env.SEED_CASHIER_EMAIL ?? "cashier@harvestlink.local";
const cashierPassword = process.env.SEED_CASHIER_PASSWORD ?? DEFAULT_CASHIER_PASSWORD;
const warehouseAdminEmail =
  process.env.SEED_WAREHOUSE_ADMIN_EMAIL ?? "warehouse@harvestlink.local";
const warehouseAdminPassword =
  process.env.SEED_WAREHOUSE_ADMIN_PASSWORD ?? DEFAULT_WAREHOUSE_ADMIN_PASSWORD;

const KNOWN_DEFAULT_PASSWORDS = new Set([
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_STORE_ADMIN_PASSWORD,
  DEFAULT_CASHIER_PASSWORD,
  DEFAULT_WAREHOUSE_ADMIN_PASSWORD,
]);

function assertProductionSeedSafe(): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  const passwords = [adminPassword, storeAdminPassword, cashierPassword, warehouseAdminPassword];
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
    if (existing.storeId !== input.storeId) {
      const updated = await prisma.user.update({
        where: { id: existing.id },
        data: { storeId: input.storeId },
      });
      console.log(`Updated store assignment: ${input.email} → ${input.storeId ?? "null"}`);
      return updated;
    }
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

async function upsertLocation(input: {
  name: string;
  address: string;
  locationType: LocationType;
  operatorPercent: number;
  taxRate: number;
}) {
  const existing = await prisma.store.findFirst({ where: { name: input.name } });
  if (existing) {
    console.log(`Skipping existing location: ${existing.name} (${existing.id})`);
    return existing;
  }
  const store = await prisma.store.create({
    data: {
      name: input.name,
      address: input.address,
      locationType: input.locationType,
      operatorPercent: input.operatorPercent,
      taxRate: input.taxRate,
      isActive: true,
    },
  });
  console.log(`Created ${input.locationType}: ${store.name} (${store.id})`);
  return store;
}

async function main() {
  assertProductionSeedSafe();

  // Keep the legacy demo retail store for older local DBs / docs that still reference it.
  await upsertLocation({
    name: "Harvestlink Demo Store",
    address: "100 Co-op Way, Demo City",
    locationType: LocationType.RETAIL_STORE,
    operatorPercent: 10.0,
    taxRate: 0,
  });

  const warehouse = await upsertLocation({
    name: "HarvestLinx Houston Warehouse",
    address: "1 Distribution Way, Houston, TX",
    locationType: LocationType.WAREHOUSE,
    operatorPercent: 0,
    taxRate: 0,
  });

  /// The Houston store is a separate location from the warehouse next door. It gets stock from the
  /// warehouse like any other store (Phase 3), so the warehouse's counts and shrinkage stay its own.
  /// A store never sells directly from warehouse lots.
  /// Opening stock (when seeded via createProduct) always goes through addLot as OPENING-<sku>-<date>
  /// — never Product.stock alone. This seed creates locations/users only; catalog/products come later.
  // taxRate: starting Houston combined rate — admin should confirm / adjust in Settings.
  const houstonStore = await upsertLocation({
    name: "HarvestLinx Houston Store",
    address: "100 Market St, Houston, TX",
    locationType: LocationType.RETAIL_STORE,
    operatorPercent: 0,
    taxRate: 8.25,
  });

  let settings = await prisma.cooperativeSettings.findFirst({ orderBy: { createdAt: "asc" } });
  if (!settings) {
    settings = await prisma.cooperativeSettings.create({
      data: {
        id: "coop_settings_default",
        votingThresholdAmount: 1000,
        fiscalYearEnd: "12-31",
        legalEntityName: "HarvestLinx Cooperative",
        stateOfIncorporation: "OH",
        mainWarehouseId: warehouse.id,
      },
    });
    console.log(`Created CooperativeSettings with mainWarehouseId=${warehouse.id}`);
  } else if (!settings.mainWarehouseId) {
    settings = await prisma.cooperativeSettings.update({
      where: { id: settings.id },
      data: { mainWarehouseId: warehouse.id },
    });
    console.log(`Set mainWarehouseId=${warehouse.id}`);
  } else {
    console.log(`CooperativeSettings mainWarehouseId already set (${settings.mainWarehouseId})`);
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
    storeId: houstonStore.id,
  });

  await upsertUser({
    email: cashierEmail,
    password: cashierPassword,
    role: Role.CASHIER,
    storeId: houstonStore.id,
  });

  // STORE_ADMIN assigned to the warehouse is its warehouse manager.
  await upsertUser({
    email: warehouseAdminEmail,
    password: warehouseAdminPassword,
    role: Role.STORE_ADMIN,
    storeId: warehouse.id,
  });

  console.log("\nSeed complete. Login with:");
  console.log(`  COOP_ADMIN          ${adminEmail} / ${adminPassword}`);
  console.log(`  STORE_ADMIN (store) ${storeAdminEmail} / ${storeAdminPassword}`);
  console.log(`  CASHIER             ${cashierEmail} / ${cashierPassword}`);
  console.log(`  WAREHOUSE manager   ${warehouseAdminEmail} / ${warehouseAdminPassword}`);
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
