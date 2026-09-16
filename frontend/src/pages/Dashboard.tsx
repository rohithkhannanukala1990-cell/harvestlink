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
import { apiRequest, todayRangeIso } from "../api/client";
import type { Product, Sale, SettlementSummary } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { storeQuery } from "../auth/storeQuery";
import {
  DataTable,
  Money,
  PageHeader,
  StatCard,
  StatusBadge,
  formatMoney,
  type DataTableColumn,
} from "../components/ui";

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
      <p className="text-ink-muted">
        Select a store (COOP_ADMIN) or sign in with a store-scoped account.
      </p>
    );
  }

  const todaysSales = salesQuery.data?.sales.filter((s) => s.paymentStatus === "PAID") ?? [];
  const todaysTotal = todaysSales.reduce((sum, s) => sum + Number(s.total), 0);
  const lowStock = productsQuery.data?.products.filter((p) => p.lowStock) ?? [];

  const lowStockColumns: DataTableColumn<Product>[] = [
    {
      id: "name",
      header: "Product",
      cell: (p) => (
        <span>
          {p.name}{" "}
          <span className="font-mono text-ink-muted">({p.sku})</span>
        </span>
      ),
    },
    {
      id: "stock",
      header: "Stock",
      numeric: true,
      cell: (p) => <span className="tabular">{p.stock}</span>,
    },
    {
      id: "reorder",
      header: "Reorder at",
      numeric: true,
      cell: (p) => <span className="tabular">{p.reorderAt}</span>,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Today's paid sales"
          value={formatMoney(todaysTotal)}
          subLine={
            <>
              <span className="tabular">{todaysSales.length}</span> transactions
            </>
          }
        />
        <StatCard
          label="Low stock SKUs"
          value={String(lowStock.length)}
          subLine="stock ≤ reorderAt"
          tone={lowStock.length > 0 ? "alert" : "default"}
        />
        {isRole("STORE_ADMIN", "COOP_ADMIN") && (
          <StatCard
            label="Owed to operator"
            value={
              settlementQuery.isLoading
                ? "…"
                : formatMoney(settlementQuery.data?.currentlyOwed ?? 0)
            }
            subLine={
              <>
                Accrued <Money value={settlementQuery.data?.operatorAccrued ?? 0} /> − paid{" "}
                <Money value={settlementQuery.data?.totalPaidOut ?? 0} />
              </>
            }
          />
        )}
      </div>

      {lowStock.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-ink">Low stock</h2>
            <StatusBadge label="Low stock" tone="warning" />
          </div>
          <DataTable
            columns={lowStockColumns}
            rows={lowStock.slice(0, 10)}
            rowKey={(p) => p.id}
            emptyMessage="No low-stock SKUs"
          />
        </section>
      )}
    </div>
  );
}
