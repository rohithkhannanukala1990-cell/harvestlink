/**
 * Shared drawer-variance display for Daily close and Audit.
 *
 * Patterns are prompts for a human to check in, never findings. Copy stays neutral: miscounts,
 * float mix-ups and POS workflow gaps are the usual causes.
 */
import type { VariancePattern } from "../api/types";
import { Card, StatusBadge, formatMoney } from "./ui";

/** Signed money so overages read as +$3.00 and shortfalls as -$2.00. */
export function SignedMoney({ value, emphasize }: { value: string; emphasize?: boolean }) {
  const n = Number(value);
  return (
    <span className={`tabular ${emphasize ? "font-semibold text-state-warning" : "text-ink"}`}>
      {n > 0 ? "+" : ""}
      {formatMoney(value)}
    </span>
  );
}

const PATTERN_COPY: Record<VariancePattern["direction"], { label: string; note: string }> = {
  SHORT: {
    label: "Consistently short",
    note: "Worth a recount together and a check of the float and change-giving.",
  },
  OVER: {
    label: "Consistently over",
    note: "Overages usually mean sales aren't being rung up correctly — worth walking through the POS workflow together.",
  },
};

export function VariancePatterns({
  patterns,
  windowLabel,
}: {
  patterns: VariancePattern[];
  windowLabel: string;
}) {
  return (
    <Card title="Patterns worth a look">
      <p className="mb-3 text-sm text-ink-muted">
        Repeated same-direction variances by one person, {windowLabel}. A prompt to check in — not
        a conclusion.
      </p>
      {patterns.length === 0 ? (
        <p className="text-sm text-ink-muted">No repeated patterns in this window.</p>
      ) : (
        <ul className="space-y-3">
          {patterns.map((p) => {
            const copy = PATTERN_COPY[p.direction];
            return (
              <li
                key={`${p.userId}-${p.drawerIds[0]}`}
                className="rounded-md border border-border-hairline p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink">{p.userEmail}</span>
                  <StatusBadge label={copy.label} tone="warning" />
                  {p.ongoing && <StatusBadge label="Most recent shift" tone="neutral" />}
                </div>
                <p className="mt-1 text-sm text-ink">
                  <span className="tabular">{p.shiftCount}</span> shifts in a row, totalling{" "}
                  <SignedMoney value={p.totalVariance} /> (
                  {new Date(p.firstClosedAt).toLocaleDateString()} –{" "}
                  {new Date(p.lastClosedAt).toLocaleDateString()})
                </p>
                <p className="mt-1 text-sm text-ink-muted">{copy.note}</p>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
