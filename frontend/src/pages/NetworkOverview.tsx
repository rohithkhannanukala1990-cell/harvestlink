/**
 * Network Overview — COOP_ADMIN-only multi-store dashboard.
 *
 * APIs:
 * - GET /stores — every store with todaysSales, stockAlertCount, currentlyOwed
 * - GET /settlement/network-summary — co-op-wide rollup totals (Phase 6)
 *
 * Why this shipped after the single-store flow: store-scoping bugs (wrong storeId on
 * inventory, sales leaking across stores, settlement mixing accruals) are much easier
 * to debug when there is only one store. Network Overview assumes per-store pages
 * already honor activeStoreId correctly; "Open store" switches that scope then links
 * into that store's Dashboard / POS / Settlement.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { apiRequest, money } from "../api/client.ts";
import type { SettlementSummary, Store } from "../api/types.ts";
import { useAuth } from "../auth/AuthContext.tsx";

type NetworkSummary = {
  storeCount: number;
  grossSales: string;
  operatorAccrued: string;
  totalPaidOut: string;
  currentlyOwed: string;
  stores: SettlementSummary[];
};

type StoreRow = Store & {
  todaysSales: string;
  stockAlertCount: number;
  currentlyOwed: string;
};

export function NetworkOverviewPage() {
  const { setStoreId } = useAuth();
  const navigate = useNavigate();

  const storesQuery = useQuery({
    queryKey: ["stores", "network"],
    queryFn: () => apiRequest<{ stores: StoreRow[] }>("/stores"),
  });

  const networkQuery = useQuery({
    queryKey: ["settlement", "network-summary"],
    queryFn: () => apiRequest<NetworkSummary>("/settlement/network-summary"),
  });

  function openStoreDashboard(storeId: string) {
    setStoreId(storeId);
    navigate("/");
  }

  const stores = storesQuery.data?.stores ?? [];
  const network = networkQuery.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Network overview</h1>
        <p className="mt-1 text-sm text-stone-600">
          COOP_ADMIN view across every store. Use Switch store in the header (or Open
          store below) before POS, Inventory, or Settlement for a specific location.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        {(
          [
            ["Stores", network ? String(network.storeCount) : "…"],
            ["Gross sales (PAID)", money(network?.grossSales ?? 0)],
            ["Operator accrued", money(network?.operatorAccrued ?? 0)],
            ["Currently owed", money(network?.currentlyOwed ?? 0)],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="rounded-lg border border-stone-200 bg-white p-4">
            <p className="text-sm text-stone-500">{label}</p>
            <p className="mt-2 text-xl font-semibold">{value}</p>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-stone-200 bg-stone-50 text-stone-600">
            <tr>
              <th className="px-3 py-2">Store</th>
              <th className="px-3 py-2">Today&apos;s sales</th>
              <th className="px-3 py-2">Stock alerts</th>
              <th className="px-3 py-2">Currently owed</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {storesQuery.isLoading && (
              <tr>
                <td className="px-3 py-3 text-stone-500" colSpan={5}>
                  Loading stores…
                </td>
              </tr>
            )}
            {!storesQuery.isLoading && stores.length === 0 && (
              <tr>
                <td className="px-3 py-3 text-stone-500" colSpan={5}>
                  No stores yet.
                </td>
              </tr>
            )}
            {stores.map((store) => (
              <tr key={store.id} className="border-b border-stone-100">
                <td className="px-3 py-3">
                  <div className="font-medium">{store.name}</div>
                  <div className="text-xs text-stone-500">{store.address}</div>
                  {!store.isActive && (
                    <span className="text-xs text-amber-700">Inactive</span>
                  )}
                </td>
                <td className="px-3 py-3">{money(store.todaysSales)}</td>
                <td className="px-3 py-3">
                  <span className={store.stockAlertCount > 0 ? "text-amber-700" : ""}>
                    {store.stockAlertCount}
                  </span>
                </td>
                <td className="px-3 py-3">{money(store.currentlyOwed)}</td>
                <td className="space-x-3 px-3 py-3">
                  <button
                    type="button"
                    className="underline"
                    onClick={() => openStoreDashboard(store.id)}
                  >
                    Open dashboard
                  </button>
                  <Link
                    to="/pos"
                    className="underline"
                    onClick={() => setStoreId(store.id)}
                  >
                    POS
                  </Link>
                  <Link
                    to="/settlement"
                    className="underline"
                    onClick={() => setStoreId(store.id)}
                  >
                    Settlement
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
