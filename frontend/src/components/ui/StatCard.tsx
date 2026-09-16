import type { ReactNode } from "react";

export type StatTone = "default" | "capital" | "alert";

export type StatCardProps = {
  label: string;
  /** Preformatted display string (caller owns units / currency formatting). */
  value: string;
  subLine?: ReactNode;
  /**
   * default = ink; capital = brand-gold for member equity (never confuse with revenue);
   * alert = state-danger.
   */
  tone?: StatTone;
  className?: string;
};

const valueToneClass: Record<StatTone, string> = {
  default: "text-ink",
  capital: "text-brand-gold",
  alert: "text-state-danger",
};

/**
 * KPI tile for dashboards. Use capital tone only for member equity / ownership
 * figures so they are never read as revenue.
 */
export function StatCard({
  label,
  value,
  subLine,
  tone = "default",
  className = "",
}: StatCardProps) {
  return (
    <div
      className={`rounded-lg border border-border-hairline bg-surface-raised p-4 shadow-card ${className}`.trim()}
    >
      <p className="text-sm font-medium text-ink-muted">{label}</p>
      <p
        className={`tabular mt-2 text-[30px] font-bold leading-none ${valueToneClass[tone]}`}
      >
        {value}
      </p>
      {subLine != null && (
        <p className="mt-2 text-sm text-ink-muted">{subLine}</p>
      )}
    </div>
  );
}
