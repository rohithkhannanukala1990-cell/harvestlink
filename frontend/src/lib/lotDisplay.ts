/**
 * Shared lot display helpers for Inventory / Lots pages.
 */
export function formatExpiry(iso: string | null, daysUntil: number | null): string {
  if (!iso) return "—";
  const d = new Date(iso).toLocaleDateString();
  if (daysUntil == null) return d;
  if (daysUntil < 0) return `${d} (${Math.abs(daysUntil)}d overdue)`;
  if (daysUntil <= 14) return `${d} (${daysUntil}d)`;
  return d;
}
