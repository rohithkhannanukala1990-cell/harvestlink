/**
 * Query-string helper so COOP_ADMIN requests always include storeId.
 */
export function storeQuery(storeId: string | null | undefined): string {
  return storeId ? `storeId=${encodeURIComponent(storeId)}` : "";
}
