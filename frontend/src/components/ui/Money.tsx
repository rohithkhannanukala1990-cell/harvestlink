import type { StatTone } from "./StatCard.tsx";

export type MoneyProps = {
  /** Decimal amount as a string or number — always rendered with two places ($8.00). */
  value: string | number;
  /** Matches StatCard tones: default ink, capital gold (equity), alert danger. */
  tone?: StatTone;
  className?: string;
};

const toneClass: Record<StatTone, string> = {
  default: "text-ink",
  capital: "text-brand-gold",
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
 * Tabular money figure for tables and summaries. Always two decimals
 * ($8.00, never $8). Use capital tone for equity, not revenue.
 */
export function Money({
  value,
  tone = "default",
  className = "",
}: MoneyProps) {
  return (
    <span className={`tabular ${toneClass[tone]} ${className}`.trim()}>
      {formatMoney(value)}
    </span>
  );
}
