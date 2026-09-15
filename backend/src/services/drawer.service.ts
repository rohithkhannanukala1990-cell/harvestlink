/**
 * Cash drawer open / close / current for Harvestlink stores.
 * Cash sales require an open drawer (enforced in createSale).
 */
import { PaymentMethod, PaymentStatus, Prisma, Role, type CashDrawer } from "@prisma/client";
import { AuditAction, writeAuditLog } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../types/auth.js";

function money(value: Prisma.Decimal | number): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export async function getCurrentDrawer(storeId: string): Promise<CashDrawer | null> {
  return prisma.cashDrawer.findFirst({
    where: { storeId, closedAt: null },
    orderBy: { openedAt: "desc" },
  });
}

export async function openDrawer(
  storeId: string,
  actor: AuthUser,
  openingFloat: number,
  ipAddress?: string | null,
): Promise<CashDrawer> {
  if (actor.role === Role.CASHIER || actor.role === Role.STORE_ADMIN) {
    if (actor.storeId !== storeId) {
      throw new AppError(403, "Cannot open a drawer for another store");
    }
  } else if (actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Insufficient role to open cash drawer");
  }

  if (!Number.isFinite(openingFloat) || openingFloat < 0) {
    throw new AppError(400, "openingFloat must be a non-negative number");
  }

  const existing = await getCurrentDrawer(storeId);
  if (existing) {
    throw new AppError(409, "A cash drawer is already open for this store", {
      drawerId: existing.id,
    });
  }

  const drawer = await prisma.cashDrawer.create({
    data: {
      storeId,
      openedByUserId: actor.id,
      openingFloat: money(openingFloat),
      expectedCash: money(0),
    },
  });

  await writeAuditLog({
    userId: actor.id,
    storeId,
    action: AuditAction.CASH_DRAWER_OPEN,
    entityType: "CashDrawer",
    entityId: drawer.id,
    after: { openingFloat: money(openingFloat).toFixed(2) },
    ipAddress: ipAddress ?? null,
  });

  return drawer;
}

/**
 * Closes the open drawer. expectedCash = openingFloat + net cash sales (PAID − refunded)
 * during the open window. variance = counted − expected.
 */
export async function closeDrawer(
  storeId: string,
  actor: AuthUser,
  countedCash: number,
  ipAddress?: string | null,
): Promise<CashDrawer> {
  if (actor.role === Role.CASHIER) {
    throw new AppError(403, "Cashiers cannot close the cash drawer");
  }
  if (actor.role === Role.STORE_ADMIN && actor.storeId !== storeId) {
    throw new AppError(403, "Cannot close a drawer for another store");
  }
  if (actor.role !== Role.STORE_ADMIN && actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Insufficient role to close cash drawer");
  }

  if (!Number.isFinite(countedCash) || countedCash < 0) {
    throw new AppError(400, "countedCash must be a non-negative number");
  }

  const drawer = await getCurrentDrawer(storeId);
  if (!drawer) {
    throw new AppError(409, "No open cash drawer for this store");
  }

  const cashSales = await prisma.sale.findMany({
    where: {
      storeId,
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: { in: [PaymentStatus.PAID, PaymentStatus.REFUNDED, PaymentStatus.REFUNDING] },
      paidAt: { gte: drawer.openedAt },
    },
    select: { total: true, refundedAmount: true },
  });

  const netCashSales = cashSales.reduce(
    (sum, s) => sum.add(s.total).sub(s.refundedAmount),
    new Prisma.Decimal(0),
  );
  const expectedCash = money(drawer.openingFloat.add(netCashSales));
  const counted = money(countedCash);
  const variance = money(counted.sub(expectedCash));

  const closed = await prisma.cashDrawer.update({
    where: { id: drawer.id },
    data: {
      closedByUserId: actor.id,
      closedAt: new Date(),
      expectedCash,
      countedCash: counted,
      variance,
    },
  });

  await writeAuditLog({
    userId: actor.id,
    storeId,
    action: AuditAction.CASH_DRAWER_CLOSE,
    entityType: "CashDrawer",
    entityId: closed.id,
    before: { openingFloat: drawer.openingFloat.toFixed(2) },
    after: {
      expectedCash: expectedCash.toFixed(2),
      countedCash: counted.toFixed(2),
      variance: variance.toFixed(2),
    },
    ipAddress: ipAddress ?? null,
  });

  return closed;
}
