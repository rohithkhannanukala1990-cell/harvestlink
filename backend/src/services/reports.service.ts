/**
 * Daily close (Z-report) for Harvestlink store operators.
 * Summarizes a UTC calendar day: tenders, tax, refunds, operator accrual, cash variance, cashiers.
 */
import { PaymentStatus, Prisma, Role } from "@prisma/client";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../types/auth.js";

function money(value: Prisma.Decimal | number): string {
  return new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);
}

function utcDayBounds(dateStr: string): { from: Date; to: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new AppError(400, "date must be YYYY-MM-DD");
  }
  const from = new Date(`${dateStr}T00:00:00.000Z`);
  const to = new Date(`${dateStr}T23:59:59.999Z`);
  if (Number.isNaN(from.getTime())) {
    throw new AppError(400, "Invalid date");
  }
  return { from, to };
}

export type DailyCloseReport = {
  storeId: string;
  storeName: string;
  date: string;
  salesByPaymentMethod: Record<string, string>;
  taxCollected: string;
  refundsTotal: string;
  operatorShareAccrued: string;
  cashVariance: string | null;
  cashierBreakdown: Array<{
    cashierId: string;
    email: string;
    saleCount: number;
    grossSales: string;
    operatorShare: string;
  }>;
};

export async function getDailyCloseReport(
  storeId: string,
  dateStr: string,
  actor: AuthUser,
): Promise<DailyCloseReport> {
  if (actor.role === Role.CASHIER) {
    throw new AppError(403, "Cashiers cannot view the daily close report");
  }
  if (actor.role === Role.STORE_ADMIN && actor.storeId !== storeId) {
    throw new AppError(403, "Cannot view another store's daily close");
  }

  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    throw new AppError(404, "Store not found");
  }

  const { from, to } = utcDayBounds(dateStr);

  const sales = await prisma.sale.findMany({
    where: {
      storeId,
      paymentStatus: {
        in: [PaymentStatus.PAID, PaymentStatus.REFUNDED, PaymentStatus.REFUNDING],
      },
      OR: [
        { paidAt: { gte: from, lte: to } },
        { paidAt: null, createdAt: { gte: from, lte: to } },
      ],
    },
    include: {
      cashier: { select: { id: true, email: true } },
    },
  });

  const byMethod: Record<string, Prisma.Decimal> = {
    CASH: new Prisma.Decimal(0),
    TERMINAL: new Prisma.Decimal(0),
    CHECKOUT: new Prisma.Decimal(0),
  };
  let taxCollected = new Prisma.Decimal(0);
  let refundsTotal = new Prisma.Decimal(0);
  let operatorShare = new Prisma.Decimal(0);

  type CashierAgg = {
    email: string;
    saleCount: number;
    gross: Prisma.Decimal;
    operator: Prisma.Decimal;
  };
  const byCashier = new Map<string, CashierAgg>();

  for (const sale of sales) {
    const netTotal = sale.total.sub(sale.refundedAmount);
    const netOp = sale.operatorAmount.sub(sale.refundedOperatorAmount);
    const method = sale.paymentMethod ?? "UNKNOWN";
    byMethod[method] = (byMethod[method] ?? new Prisma.Decimal(0)).add(netTotal);

    // Tax collected net of refunds (proportional to remaining share of total).
    const taxShare =
      sale.total.eq(0) || sale.refundedAmount.eq(0)
        ? sale.taxAmount
        : sale.taxAmount.mul(netTotal).div(sale.total);
    taxCollected = taxCollected.add(taxShare);
    refundsTotal = refundsTotal.add(sale.refundedAmount);
    operatorShare = operatorShare.add(netOp);

    const row = byCashier.get(sale.cashierId) ?? {
      email: sale.cashier.email,
      saleCount: 0,
      gross: new Prisma.Decimal(0),
      operator: new Prisma.Decimal(0),
    };
    row.saleCount += 1;
    row.gross = row.gross.add(netTotal);
    row.operator = row.operator.add(netOp);
    byCashier.set(sale.cashierId, row);
  }

  const drawers = await prisma.cashDrawer.findMany({
    where: {
      storeId,
      closedAt: { gte: from, lte: to },
    },
    orderBy: { closedAt: "desc" },
  });
  const cashVariance =
    drawers.length === 0
      ? null
      : money(drawers.reduce((sum, d) => sum.add(d.variance ?? 0), new Prisma.Decimal(0)));

  return {
    storeId: store.id,
    storeName: store.name,
    date: dateStr,
    salesByPaymentMethod: {
      CASH: money(byMethod.CASH ?? 0),
      TERMINAL: money(byMethod.TERMINAL ?? 0),
      CHECKOUT: money(byMethod.CHECKOUT ?? 0),
    },
    taxCollected: money(taxCollected),
    refundsTotal: money(refundsTotal),
    operatorShareAccrued: money(operatorShare),
    cashVariance,
    cashierBreakdown: [...byCashier.entries()].map(([cashierId, row]) => ({
      cashierId,
      email: row.email,
      saleCount: row.saleCount,
      grossSales: money(row.gross),
      operatorShare: money(row.operator),
    })),
  };
}
