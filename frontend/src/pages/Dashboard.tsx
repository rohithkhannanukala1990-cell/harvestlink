/**
 * Dashboard — store pulse for the logged-in scope.
 *
 * APIs:
 * - GET /sales?from&to — today's sales (CASHIER, STORE_ADMIN, COOP_ADMIN)
 * - GET /products — low-stock flags (same roles; COOP_ADMIN needs storeId)
 * - GET /settlement/:storeId/summary — amount owed (STORE_ADMIN, COOP_ADMIN only)
 *
 * Cashiers see sales + low stock; settlement card is hidden for CASHIER.
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest, money, todayRangeIso } from "../api/client";
import type { Product, Sale, SettlementSummary } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { storeQuery } from "../auth/storeQuery";

export function DashboardPage() {
  const { activeStoreId, isRole } = useAuth();
  const { from, to } = todayRangeIso();
  const q = storeQuery(activeStoreId);

  const salesQuery = useQuery({
    queryKey: ["sales", "today", activeStoreId],
    enabled: !!activeStoreId,
    queryFn: () =>
      apiRequest<{ sales: Sale[]; total: number }>(
        `/sales?page=1&pageSize=50&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${q ? `&${q}` : ""}`,
      ),
  });

  const productsQuery = useQuery({
    queryKey: ["products", activeStoreId],
    enabled: !!activeStoreId,
    queryFn: () =>
      apiRequest<{ products: Product[] }>(`/products${q ? `?${q}` : ""}`),
  });

  const settlementQuery = useQuery({
    queryKey: ["settlement", activeStoreId],
    enabled: !!activeStoreId && isRole("STORE_ADMIN", "COOP_ADMIN"),
    queryFn: () =>
      apiRequest<SettlementSummary>(`/settlement/${activeStoreId}/summary`),
  });

  if (!activeStoreId) {
    return (
      <p className="text-stone-600">
        Select a store (COOP_ADMIN) or sign in with a store-scoped account.
      </p>
    );
  }

  const todaysSales = salesQuery.data?.sales.filter((s) => s.paymentStatus === "PAID") ?? [];
  const todaysTotal = todaysSales.reduce((sum, s) => sum + Number(s.total), 0);
  const lowStock = productsQuery.data?.products.filter((p) => p.lowStock) ?? [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-stone-200 bg-white p-4">
          <p className="text-sm text-stone-500">Today&apos;s paid sales</p>
          <p className="mt-2 text-2xl font-semibold">{money(todaysTotal)}</p>
          <p className="mt-1 text-sm text-stone-500">{todaysSales.length} transactions</p>
        </div>
        <div className="rounded-lg border border-stone-200 bg-white p-4">
          <p className="text-sm text-stone-500">Low stock SKUs</p>
          <p className="mt-2 text-2xl font-semibold">{lowStock.length}</p>
          <p className="mt-1 text-sm text-stone-500">stock ≤ reorderAt</p>
        </div>
        {isRole("STORE_ADMIN", "COOP_ADMIN") && (
          <div className="rounded-lg border border-stone-200 bg-white p-4">
            <p className="text-sm text-stone-500">Owed to operator</p>
            <p className="mt-2 text-2xl font-semibold">
              {settlementQuery.isLoading
                ? "…"
                : money(settlementQuery.data?.currentlyOwed ?? 0)}
            </p>
            <p className="mt-1 text-sm text-stone-500">
              Accrued {money(settlementQuery.data?.operatorAccrued ?? 0)} − paid{" "}
              {money(settlementQuery.data?.totalPaidOut ?? 0)}
            </p>
          </div>
        )}
      </div>

      {lowStock.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-medium">Low stock</h2>
          <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white">
            {lowStock.slice(0, 10).map((p) => (
              <li key={p.id} className="flex justify-between px-4 py-2 text-sm">
                <span>
                  {p.name} <span className="text-stone-400">({p.sku})</span>
                </span>
                <span>
                  {p.stock} / reorder {p.reorderAt}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
