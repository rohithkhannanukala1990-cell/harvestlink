/**
 * Network Overview — COOP_ADMIN-only multi-store dashboard.
 *
 * APIs:
 * - GET /stores — every store with todaysSales, stockAlertCount, currentlyOwed
 * - GET /settlement/network-summary — co-op-wide rollup totals (Phase 6)
 */
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { apiRequest } from "../api/client.ts";
import type { SettlementSummary, Store } from "../api/types.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import {
  Button,
  DataTable,
  Money,
  PageHeader,
  StatCard,
  StatusBadge,
  formatMoney,
  type DataTableColumn,
} from "../components/ui";

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

  const columns: DataTableColumn<StoreRow>[] = [
    {
      id: "store",
      header: "Store",
      cell: (store) => (
        <div>
          <div className="font-semibold text-ink">{store.name}</div>
          <div className="text-xs text-ink-muted">{store.address}</div>
          {!store.isActive && (
            <span className="mt-1 inline-block">
              <StatusBadge label="Closed" tone="neutral" />
            </span>
          )}
        </div>
      ),
    },
    {
      id: "sales",
      header: "Today's sales",
      numeric: true,
      cell: (store) => <Money value={store.todaysSales} />,
    },
    {
      id: "alerts",
      header: "Stock alerts",
      numeric: true,
      cell: (store) =>
        store.stockAlertCount > 0 ? (
          <span className="inline-flex items-center gap-2">
            <StatusBadge label="Low stock" tone="warning" />
            <span className="tabular text-ink">{store.stockAlertCount}</span>
          </span>
        ) : (
          <span className="tabular text-ink">{store.stockAlertCount}</span>
        ),
    },
    {
      id: "owed",
      header: "Currently owed",
      numeric: true,
      cell: (store) => <Money value={store.currentlyOwed} tone="alert" />,
    },
    {
      id: "actions",
      header: "Actions",
      cell: (store) => (
        <span className="inline-flex flex-wrap gap-2">
          <Button type="button" variant="quiet" onClick={() => openStoreDashboard(store.id)}>
            Open dashboard
          </Button>
          <Link
            to="/pos"
            className="inline-flex min-h-[44px] items-center rounded-md border border-border-strong bg-surface-raised px-4 text-sm font-semibold text-ink"
            onClick={() => setStoreId(store.id)}
          >
            POS
          </Link>
          <Link
            to="/settlement"
            className="inline-flex min-h-[44px] items-center rounded-md border border-border-strong bg-surface-raised px-4 text-sm font-semibold text-ink"
            onClick={() => setStoreId(store.id)}
          >
            Settlement
          </Link>
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Network overview"
        description="COOP_ADMIN view across every store. Use Switch store in the header (or Open store below) before POS, Inventory, or Settlement for a specific location."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Stores"
          value={network ? String(network.storeCount) : "…"}
        />
        <StatCard
          label="Gross sales (PAID)"
          value={formatMoney(network?.grossSales ?? 0)}
        />
        <StatCard
          label="Operator share accrued"
          value={formatMoney(network?.operatorAccrued ?? 0)}
        />
        <StatCard
          label="Currently owed"
          value={formatMoney(network?.currentlyOwed ?? 0)}
          tone="alert"
        />
      </div>

      <DataTable
        columns={columns}
        rows={stores}
        rowKey={(s) => s.id}
        emptyMessage={storesQuery.isLoading ? "Loading stores…" : "No stores yet."}
      />
    </div>
  );
}
