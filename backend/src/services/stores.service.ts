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
import { PaymentStatus, Prisma, Role, type Store } from "@prisma/client";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../types/auth.js";

export type UpdateStoreInput = {
  name?: string;
  address?: string;
  /** Only COOP_ADMIN may set this — affects future sales only, never historical ones. */
  operatorPercent?: number;
  isActive?: boolean;
};

export type StoreWithStats = Store & {
  /** Sum of PAID Sale.total for the store since UTC midnight. */
  todaysSales: string;
  /** Count of products where stock <= reorderAt. */
  stockAlertCount: number;
  /** operatorAccrued − totalPaidOut from the settlement ledger (PAID sales only). */
  currentlyOwed: string;
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
    prisma.sale.aggregate({
      where: {
        storeId: store.id,
        paymentStatus: PaymentStatus.PAID,
        createdAt: { gte: from, lte: to },
      },
      _sum: { total: true },
    }),
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "Product"
      WHERE "storeId" = ${store.id}
        AND stock <= "reorderAt"
    `,
    prisma.sale.aggregate({
      where: { storeId: store.id, paymentStatus: PaymentStatus.PAID },
      _sum: { operatorAmount: true },
    }),
    prisma.payout.aggregate({
      where: { storeId: store.id },
      _sum: { amount: true },
    }),
  ]);

  const accrued = new Prisma.Decimal(operatorAccruedAgg._sum.operatorAmount ?? 0);
  const paidOut = new Prisma.Decimal(payoutsAgg._sum.amount ?? 0);

  return {
    ...store,
    todaysSales: moneyString(new Prisma.Decimal(todaysSalesAgg._sum.total ?? 0)),
    stockAlertCount: Number(alertRows[0]?.count ?? 0),
    currentlyOwed: moneyString(accrued.sub(paidOut)),
  };
}

/**
 * Lists stores the caller may see, each with basic network stats.
 * COOP_ADMIN gets every store — used by Network Overview and the Switch store control.
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

  return Promise.all(stores.map((store) => statsForStore(store)));
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
  await getStore(storeId);

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

  return prisma.store.update({
    where: { id: storeId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.operatorPercent !== undefined
        ? { operatorPercent: new Prisma.Decimal(input.operatorPercent) }
        : {}),
    },
  });
}
