/**
 * Shared lot status colour helpers for Inventory / Lots pages.
 */
import type { Lot, LotStatus } from "../api/types";

export function lotRowClass(lot: Pick<Lot, "status" | "daysUntilExpiry">): string {
  if (lot.status === "QUARANTINED" || lot.status === "RECALLED") {
    return "bg-red-50 text-red-950";
  }
  if (lot.status === "EXPIRED") {
    return "bg-stone-200 text-stone-700";
  }
  if (
    lot.status === "ACTIVE" &&
    lot.daysUntilExpiry != null &&
    lot.daysUntilExpiry <= 14
  ) {
    return "bg-amber-50 text-amber-950";
  }
  return "";
}

export function lotStatusBadge(status: LotStatus): string {
  switch (status) {
    case "QUARANTINED":
    case "RECALLED":
      return "rounded px-1.5 py-0.5 text-xs font-medium bg-red-200 text-red-900";
    case "EXPIRED":
      return "rounded px-1.5 py-0.5 text-xs font-medium bg-stone-300 text-stone-800";
    case "DEPLETED":
      return "rounded px-1.5 py-0.5 text-xs font-medium bg-stone-100 text-stone-600";
    default:
      return "rounded px-1.5 py-0.5 text-xs font-medium bg-emerald-100 text-emerald-900";
  }
}

export function formatExpiry(iso: string | null, daysUntil: number | null): string {
  if (!iso) return "—";
  const d = new Date(iso).toLocaleDateString();
  if (daysUntil == null) return d;
  if (daysUntil < 0) return `${d} (${Math.abs(daysUntil)}d overdue)`;
  if (daysUntil <= 14) return `${d} (${daysUntil}d)`;
  return d;
}
