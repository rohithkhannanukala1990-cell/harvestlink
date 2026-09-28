import type { StoreCashPosition } from "../../api/types.ts";
import type { StatTone } from "./StatCard.tsx";

type AgeFlags = Pick<StoreCashPosition, "pastGrace" | "pastDoubleGrace">;

/** Undeposited cash: warning past the grace period, alert past double grace. */
export function cashPositionTone(position: AgeFlags): StatTone {
  if (position.pastDoubleGrace) return "alert";
  if (position.pastGrace) return "warning";
  return "default";
}

export function formatDaysOutstanding(days: number): string {
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * Prompt copy for undeposited cash. Worded as a nudge, not a notice: cash left in a store is a
 * risk to the operator as much as to the co-op, and every risk grows with age.
 */
export function cashPositionPrompt(
  position: AgeFlags & Pick<StoreCashPosition, "undepositedTotal" | "graceDays">,
): string {
  if (Number(position.undepositedTotal) <= 0) return "Every closed shift is banked.";
  if (position.pastDoubleGrace) return "Worth a bank run today — cash is safest once it's deposited.";
  if (position.pastGrace) return "A bank run soon keeps this cash safe.";
  return `Aim to bank within ${position.graceDays} days of closing a shift.`;
}
