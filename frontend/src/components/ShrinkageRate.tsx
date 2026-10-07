/**
 * Shared shrinkage-rate display for the Shrinkage page, Dashboard and Network overview.
 *
 * The rate (value lost ÷ sales at cost) is the number to compare; raw value grows with volume.
 * A store is flagged only relative to the network — there is no fixed "acceptable" rate for a mix
 * of fresh produce and dry goods.
 */
import { apiRequest } from "../api/client";
import type { ShrinkageReport } from "../api/types";
import type { StatTone } from "./ui";

export type ShrinkageParams = { storeId?: string | null; from?: string; to?: string };

export function shrinkageQueryString({ storeId, from, to }: ShrinkageParams): string {
  const params = new URLSearchParams();
  if (storeId) params.set("storeId", storeId);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return params.toString();
}

export function fetchShrinkage(params: ShrinkageParams): Promise<ShrinkageReport> {
  const qs = shrinkageQueryString(params);
  return apiRequest<ShrinkageReport>(`/reports/shrinkage${qs ? `?${qs}` : ""}`);
}

/** "—" when there were no sales at cost to measure against. */
export function formatRate(rate: string | null | undefined): string {
  return rate == null ? "—" : `${rate}%`;
}

export function shrinkageRateTone(
  rate: string | null | undefined,
  networkRate: string | null | undefined,
): StatTone {
  if (rate == null || networkRate == null) return "default";
  return Number(rate) > Number(networkRate) ? "warning" : "default";
}

export const SHRINKAGE_REASON_LABELS: Record<string, string> = {
  THEFT_SUSPECTED: "Theft suspected",
  DAMAGE: "Damage",
  SPOILAGE: "Spoilage",
  EXPIRY: "Expired",
  RECEIVING_ERROR: "Receiving error",
  COUNTING_ERROR: "Counting error",
  SYSTEM_ERROR: "System error",
  UNKNOWN: "Unexplained",
  RECALL: "Recall",
  RETURNED_NOT_RESTOCKED: "Returned, not restocked",
  MANUAL_ADJUSTMENT: "Manual stock adjustment",
  OTHER: "Other write-off",
};

export const SHRINKAGE_SOURCE_LABELS: Record<ShrinkageReport["bySource"][number]["source"], string> = {
  EXPIRY_JOB: "Expiry job",
  RECALL: "Recall activation",
  REFUND_NO_RESTOCK: "Refunds not restocked",
  STOCK_COUNT: "Stock count approvals",
  MANUAL_ADJUSTMENT: "Manual stock adjustments",
  OTHER_WRITE_OFF: "Other write-offs",
};
