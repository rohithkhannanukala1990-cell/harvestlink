import type { ReactNode } from "react";

export type StatusTone =
  | "success"
  | "warning"
  | "danger"
  | "neutral"
  | "gold";

/** Known operational labels and the tone they must use. */
export const STATUS_TONE_BY_LABEL = {
  Active: "success",
  Confirmed: "success",
  Delivered: "success",
  Paid: "success",
  "Awaiting payment": "warning",
  "Near expiry": "warning",
  "Low stock": "warning",
  Pending: "warning",
  Recalled: "danger",
  Quarantined: "danger",
  Failed: "danger",
  Rejected: "danger",
  Expired: "neutral",
  Depleted: "neutral",
  Closed: "neutral",
  Cancelled: "neutral",
  "Voting rights": "gold",
  "Founding investor": "gold",
} as const satisfies Record<string, StatusTone>;

export type KnownStatusLabel = keyof typeof STATUS_TONE_BY_LABEL;

export type StatusBadgeProps = {
  /**
   * Always a readable word — colour never carries meaning alone.
   * A colour-blind coordinator and a printed pick list must both read it.
   */
  label: string;
  tone: StatusTone;
  className?: string;
};

const toneClass: Record<StatusTone, string> = {
  success: "bg-state-success/15 text-state-success",
  warning: "bg-state-warning/15 text-state-warning",
  danger: "bg-state-danger/15 text-state-danger",
  neutral: "bg-surface-sunken text-ink-muted",
  gold: "bg-brand-gold/15 text-brand-gold",
};

function SafetyIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden
      className="shrink-0"
    >
      <path
        fill="currentColor"
        d="M8 1.5 1.5 13h13L8 1.5zm0 3.2c.4 0 .7.4.7.8v3.2a.7.7 0 1 1-1.4 0V5.5c0-.4.3-.8.7-.8zm0 7.1a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8z"
      />
    </svg>
  );
}

/**
 * Compact status pill. Colour is a secondary cue only — the label is required,
 * and danger / safety-critical states also show a warning icon.
 */
export function StatusBadge({ label, tone, className = "" }: StatusBadgeProps) {
  const showSafetyIcon = tone === "danger";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${toneClass[tone]} ${className}`.trim()}
    >
      {showSafetyIcon ? <SafetyIcon /> : null}
      {label}
    </span>
  );
}

/** Resolve tone for a known status word; fall back to neutral for unknowns. */
export function toneForStatusLabel(label: string): StatusTone {
  if (label in STATUS_TONE_BY_LABEL) {
    return STATUS_TONE_BY_LABEL[label as KnownStatusLabel];
  }
  return "neutral";
}

/** Convenience: badge from a known (or free-text) status word. */
export function StatusBadgeFromLabel({
  label,
  className,
}: {
  label: string;
  className?: string;
}): ReactNode {
  return (
    <StatusBadge
      label={label}
      tone={toneForStatusLabel(label)}
      className={className}
    />
  );
}
