/**
 * Shared money helpers — always Prisma.Decimal, never JS floating point.
 *
 * moneyDec    — currency totals (2 dp, ROUND_HALF_UP)
 * unitCostDec — per-unit cost (4 dp, ROUND_HALF_UP)
 *
 * Totals = unitCost × qty, THEN moneyDec. Never round the unit first.
 */
import { Prisma } from "@prisma/client";

export function moneyDec(value: Prisma.Decimal | string | number): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** Per-unit cost / Product.cost — 4 decimal places. */
export function unitCostDec(value: Prisma.Decimal | string | number): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
}
