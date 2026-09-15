/**
 * Shared money helpers — always Prisma.Decimal, half-up to 2 places.
 * Never use JS floating point for currency.
 */
import { Prisma } from "@prisma/client";

export function moneyDec(value: Prisma.Decimal | string | number): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}
