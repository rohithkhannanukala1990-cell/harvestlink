import type { LotStatus } from "../../api/types.ts";
import { StatusBadge, type StatusTone } from "./StatusBadge.tsx";

/** Lot lifecycle → StatusBadge label (word always present; colour is secondary). */
const LOT_STATUS_LABEL: Record<LotStatus, string> = {
  ACTIVE: "Active",
  QUARANTINED: "Quarantined",
  RECALLED: "Recalled",
  EXPIRED: "Expired",
  DEPLETED: "Depleted",
};

const LOT_STATUS_TONE: Record<LotStatus, StatusTone> = {
  ACTIVE: "success",
  QUARANTINED: "danger",
  RECALLED: "danger",
  EXPIRED: "neutral",
  DEPLETED: "neutral",
};

/**
 * Lot status pill for inventory / lots / receipts.
 * Prefer this over colour-only row tints — always renders the word.
 */
export function LotStatusBadge({
  status,
  nearExpiry = false,
  className = "",
}: {
  status: LotStatus;
  /** When ACTIVE and ≤14 days — shows Near expiry instead of Active. */
  nearExpiry?: boolean;
  className?: string;
}) {
  if (status === "ACTIVE" && nearExpiry) {
    return (
      <StatusBadge label="Near expiry" tone="warning" className={className} />
    );
  }
  return (
    <StatusBadge
      label={LOT_STATUS_LABEL[status]}
      tone={LOT_STATUS_TONE[status]}
      className={className}
    />
  );
}

/** True when remaining units on this lot must not be sold. */
export function isLotBlockedFromSale(status: LotStatus): boolean {
  return status === "QUARANTINED" || status === "RECALLED";
}
