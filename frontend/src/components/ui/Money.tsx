import type { StatTone } from "./StatCard.tsx";

export type MoneyProps = {
  /** Decimal amount as a string or number — always rendered with two places ($8.00). */
  value: string | number;
  /** Matches StatCard tones: default ink, capital gold (equity), warning, alert danger. */
  tone?: StatTone;
  className?: string;
};

const toneClass: Record<StatTone, string> = {
  default: "text-ink",
  capital: "text-brand-gold",
  warning: "text-state-warning",
  alert: "text-state-danger",
};

/** Format as currency with exactly two decimal places. Never strips .00. */
export function formatMoney(value: string | number): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return "$0.00";
  }
  const negative = n < 0;
  const formatted = Math.abs(n).toFixed(2);
  return `${negative ? "-" : ""}$${formatted}`;
}

/**
 * Per-unit cost for admin screens (lots, receiving, catalog cost).
 * Up to 4 decimal places; always keeps at least 2.
 */
export function formatUnitCost(value: string | number): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return "$0.00";
  }
  const negative = n < 0;
  let formatted = Math.abs(n).toFixed(4);
  while (formatted.includes(".") && formatted.endsWith("0") && formatted.split(".")[1]!.length > 2) {
    formatted = formatted.slice(0, -1);
  }
  return `${negative ? "-" : ""}$${formatted}`;
}

/**
 * Tabular money figure for tables and summaries. Always two decimals
 * ($8.00, never $8). Use capital tone for equity, not revenue.
 */
export function Money({
  value,
  tone = "default",
  className = "",
}: MoneyProps) {
  return (
    <span
      className={
        className
          ? `tabular ${className}`.trim()
          : `tabular ${toneClass[tone]}`.trim()
      }
    >
      {formatMoney(value)}
    </span>
  );
}

/** Tabular unit-cost figure (up to 4 dp) for lots / receiving / cost detail. */
export function UnitCost({
  value,
  tone = "default",
  className = "",
}: MoneyProps) {
  return (
    <span
      className={
        className
          ? `tabular ${className}`.trim()
          : `tabular ${toneClass[tone]}`.trim()
      }
    >
      {formatUnitCost(value)}
    </span>
  );
}
