/**
 * Store settings + co-op network listing for Harvestlink.
 *
 * operatorPercent changes apply only to FUTURE sales — past Sale rows keep their
 * snapshotted operatorPercent / operatorAmount from checkout time (Phases 1 & 4).
 *
 * Network listing (COOP_ADMIN) was deferred until the single-store flow was solid:
 * store-scoping bugs (JWT storeId vs query storeId, wrong inventory, settlement bleed)
 * are far easier to debug when there is only ever one store under test. Multi-store
 * overview builds on that once POS / inventory / settlement are trustworthy per store.
 */
import { Prisma, Role, type Store } from "@prisma/client";
import { AuditAction, writeAuditLog } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../types/auth.js";

export type UpdateStoreInput = {
  name?: string;
  address?: string;
  /** Only COOP_ADMIN may set this — affects future sales only, never historical ones. */
  operatorPercent?: number;
  taxRate?: number;
  refundPolicy?: string;
  isActive?: boolean;
  /** Client IP for audit log (operatorPercent changes). */
  ipAddress?: string | null;
};

export type StoreWithStats = Store & {
  /** Sum of net PAID sales (total − refundedAmount) for the store since UTC midnight. */
  todaysSales: string;
  /** Count of products where available (stock - reserved) <= reorderAt. */
  stockAlertCount: number;
  /** Net operatorAccrued − totalPaidOut (refunds claw back operator share). Omitted for CASHIER. */
  currentlyOwed?: string;
};

export function assertStoreAccess(actor: AuthUser, storeId: string): void {
  if (actor.role === Role.COOP_ADMIN) {
    return;
  }
  if (actor.role === Role.STORE_ADMIN || actor.role === Role.CASHIER) {
    if (!actor.storeId || actor.storeId !== storeId) {
      throw new AppError(403, "Cannot access another store");
    }
    return;
  }
  throw new AppError(403, "Insufficient role");
}

function moneyString(value: Prisma.Decimal): string {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);
}

function utcDayBounds(now = new Date()): { from: Date; to: Date } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = new Date(from);
  to.setUTCHours(23, 59, 59, 999);
  return { from, to };
}

async function statsForStore(store: Store): Promise<StoreWithStats> {
  const { from, to } = utcDayBounds();

  const [todaysSalesAgg, alertRows, operatorAccruedAgg, payoutsAgg] = await Promise.all([
    prisma.$queryRaw<Array<{ gross: Prisma.Decimal }>>`
      SELECT COALESCE(SUM(total - "refundedAmount"), 0) AS gross
      FROM "Sale"
      WHERE "storeId" = ${store.id}
        AND "paymentStatus"::text IN ('PAID', 'REFUNDING', 'REFUNDED')
        AND "createdAt" >= ${from}
        AND "createdAt" <= ${to}
    `,
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "Product"
      WHERE "storeId" = ${store.id}
        AND (stock - reserved) <= "reorderAt"
    `,
    prisma.$queryRaw<Array<{ accrued: Prisma.Decimal }>>`
      SELECT COALESCE(SUM("operatorAmount" - "refundedOperatorAmount"), 0) AS accrued
      FROM "Sale"
      WHERE "storeId" = ${store.id}
        AND "paymentStatus"::text IN ('PAID', 'REFUNDING', 'REFUNDED')
    `,
    prisma.payout.aggregate({
      where: { storeId: store.id },
      _sum: { amount: true },
    }),
  ]);

  const accrued = new Prisma.Decimal(operatorAccruedAgg[0]?.accrued ?? 0);
  const paidOut = new Prisma.Decimal(payoutsAgg._sum.amount ?? 0);

  return {
    ...store,
    todaysSales: moneyString(new Prisma.Decimal(todaysSalesAgg[0]?.gross ?? 0)),
    stockAlertCount: Number(alertRows[0]?.count ?? 0),
    currentlyOwed: moneyString(accrued.sub(paidOut)),
  };
}

/**
 * Lists stores the caller may see, each with basic network stats.
 * COOP_ADMIN gets every store — used by Network Overview and the Switch store control.
 * CASHIER responses omit currentlyOwed (settlement payable is admin-only).
 */
export async function listStores(actor: AuthUser): Promise<StoreWithStats[]> {
  let stores: Store[];

  if (actor.role === Role.COOP_ADMIN) {
    stores = await prisma.store.findMany({ orderBy: { name: "asc" } });
  } else {
    if (!actor.storeId) {
      throw new AppError(403, "User is not assigned to a store");
    }
    const store = await prisma.store.findUnique({ where: { id: actor.storeId } });
    stores = store ? [store] : [];
  }

  const withStats = await Promise.all(stores.map((store) => statsForStore(store)));

  if (actor.role === Role.CASHIER) {
    return withStats.map((row) => {
      const rest = { ...row };
      delete rest.currentlyOwed;
      return rest;
    });
  }

  return withStats;
}

export async function getStore(storeId: string): Promise<Store> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    throw new AppError(404, "Store not found");
  }
  return store;
}

export async function updateStore(
  storeId: string,
  actor: AuthUser,
  input: UpdateStoreInput,
): Promise<Store> {
  const existing = await getStore(storeId);

  if (input.operatorPercent !== undefined && actor.role !== Role.COOP_ADMIN) {
    throw new AppError(
      403,
      "Only COOP_ADMIN can change operatorPercent (future sales only; past sales keep snapshots)",
    );
  }

  if (input.operatorPercent !== undefined) {
    if (input.operatorPercent < 0 || input.operatorPercent > 100) {
      throw new AppError(400, "operatorPercent must be between 0 and 100");
    }
  }

  if (input.taxRate !== undefined && (input.taxRate < 0 || input.taxRate > 100)) {
    throw new AppError(400, "taxRate must be between 0 and 100");
  }

  const updated = await prisma.store.update({
    where: { id: storeId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.refundPolicy !== undefined ? { refundPolicy: input.refundPolicy } : {}),
      ...(input.operatorPercent !== undefined
        ? { operatorPercent: new Prisma.Decimal(input.operatorPercent) }
        : {}),
      ...(input.taxRate !== undefined ? { taxRate: new Prisma.Decimal(input.taxRate) } : {}),
    },
  });

  // Critical money control: operator earnings rate — always audit when it changes.
  if (
    input.operatorPercent !== undefined &&
    !existing.operatorPercent.equals(updated.operatorPercent)
  ) {
    await writeAuditLog({
      userId: actor.id,
      storeId,
      action: AuditAction.STORE_OPERATOR_PERCENT_CHANGE,
      entityType: "Store",
      entityId: storeId,
      before: { operatorPercent: existing.operatorPercent.toFixed(2) },
      after: { operatorPercent: updated.operatorPercent.toFixed(2) },
      ipAddress: input.ipAddress ?? null,
    });
  }

  return updated;
}
