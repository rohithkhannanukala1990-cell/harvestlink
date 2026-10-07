/**
 * Quantity typed on a scan screen. "12+6+3" is allowed so stock found in more than one place
 * (shelf, backroom, endcap) can be added up on a numeric keypad, which has a + key, before saving:
 * a count line is saved once, so the parts must be summed first.
 */
const MAX_QUANTITY = 1_000_000;

/** Whole non-negative total, or null when the entry is empty or not a sum of whole numbers. */
export function parseQuantityEntry(entry: string): number | null {
  const s = entry.replace(/\s+/g, "");
  if (!/^\d+(\+\d+)*$/.test(s)) return null;
  const total = s.split("+").reduce((sum, part) => sum + Number(part), 0);
  return Number.isSafeInteger(total) && total <= MAX_QUANTITY ? total : null;
}
