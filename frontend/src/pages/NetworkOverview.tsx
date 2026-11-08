/**
 * Network Overview — COOP_ADMIN-only multi-store dashboard.
 *
 * APIs:
 * - GET /stores — every store with todaysSales, stockAlertCount, currentlyOwed
 * - GET /settlement/network-summary — co-op-wide rollup totals (Phase 6)
 * - GET /settlement/network-cash-position — undeposited cash per store, worst first
 * - GET /reports/shrinkage — last 30 days' shrinkage rate for the network and each store
 * - GET /compliance/expiring-certifications — supplier certs / reviews due within 30 days
 *
 * Rows follow the cash-position order so the store whose cash has waited longest is on top.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { apiRequest } from "../api/client.ts";
import type { SettlementSummary, Store, StoreCashPosition } from "../api/types.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { fetchShrinkage, formatRate, shrinkageRateTone } from "../components/ShrinkageRate.tsx";
import {
  Button,
  DataTable,
  Money,
  PageHeader,
  StatCard,
  StatusBadge,
  cashPositionTone,
  formatDaysOutstanding,
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

type ExpiringCertification = {
  id: string;
  supplierId: string;
  supplierName: string;
  certType: string;
  certNumber: string;
  expiresAt: string | null;
  nextReviewDue: string | null;
  reason: "EXPIRING" | "REVIEW_DUE";
  daysUntil: number;
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

  const cashQuery = useQuery({
    queryKey: ["cash-position", "network"],
    queryFn: () =>
      apiRequest<{ graceDays: number; stores: StoreCashPosition[] }>(
        "/settlement/network-cash-position",
      ),
  });

  const shrinkageQuery = useQuery({
    queryKey: ["shrinkage", null, "last-30-days"],
    queryFn: () => fetchShrinkage({}),
  });

  const certsQuery = useQuery({
    queryKey: ["compliance", "expiring-certifications"],
    queryFn: () =>
      apiRequest<{ certifications: ExpiringCertification[] }>(
        "/compliance/expiring-certifications?days=30",
      ),
  });

  function openStoreDashboard(storeId: string) {
    setStoreId(storeId);
    navigate("/");
  }

  const cashPositions = cashQuery.data?.stores ?? [];
  const cashByStore = new Map(cashPositions.map((p) => [p.storeId, p]));
  const worstFirst = new Map(cashPositions.map((p, index) => [p.storeId, index]));
  const allLocations = storesQuery.data?.stores ?? [];
  // Warehouses separately — never mix into retail sales / cash / owed comparisons.
  const warehouses = allLocations.filter((s) => s.locationType === "WAREHOUSE");
  const stores = allLocations
    .filter((s) => s.locationType !== "WAREHOUSE")
    .sort(
      (a, b) =>
        (worstFirst.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (worstFirst.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
  const network = networkQuery.data;
  const shrinkage = shrinkageQuery.data;
  const networkShrinkageRate = shrinkage?.comparison.networkRatePercent ?? null;
  const shrinkageByStore = new Map(
    (shrinkage?.comparison.stores ?? []).map((s) => [s.storeId, s]),
  );
  const expiringCerts = certsQuery.data?.certifications ?? [];

  const columns: DataTableColumn<StoreRow>[] = [
    {
      id: "store",
      header: "Store",
      cell: (store) => (
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">{store.name}</span>
            {store.locationType === "WAREHOUSE" && (
              <StatusBadge label="Warehouse" tone="neutral" />
            )}
          </div>
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
      id: "cash",
      header: "Cash to deposit",
      numeric: true,
      cell: (store) => {
        const cash = cashByStore.get(store.id);
        if (!cash) return <span className="text-ink-muted">…</span>;
        if (Number(cash.undepositedTotal) <= 0) {
          return <Money value={0} className="text-ink-muted" />;
        }
        return (
          <span className="inline-flex flex-col items-end">
            <Money value={cash.undepositedTotal} tone={cashPositionTone(cash)} />
            <span className="text-xs text-ink-muted">
              {formatDaysOutstanding(cash.daysOutstanding)}
            </span>
          </span>
        );
      },
    },
    {
      id: "shrinkage",
      header: "Shrinkage · 30d",
      numeric: true,
      cell: (store) => {
        if (!shrinkage) return <span className="text-ink-muted">…</span>;
        const row = shrinkageByStore.get(store.id);
        if (!row) return <span className="text-ink-muted">—</span>;
        const above = shrinkageRateTone(row.ratePercent, networkShrinkageRate) === "warning";
        return (
          <span className="inline-flex flex-col items-end">
            <span className={`tabular ${above ? "font-semibold text-state-warning" : "text-ink"}`}>
              {formatRate(row.ratePercent)}
              {above && <span className="ml-1 text-xs">▲ above network</span>}
            </span>
            <span className="text-xs text-ink-muted">
              <Money value={row.value} className="text-ink-muted" /> lost
            </span>
          </span>
        );
      },
    },
    {
      id: "actions",
      header: "Actions",
      cell: (store) => (
        <span className="inline-flex flex-wrap gap-2">
          <Button type="button" variant="quiet" onClick={() => openStoreDashboard(store.id)}>
            Open dashboard
          </Button>
          {store.locationType !== "WAREHOUSE" && (
            <Link
              to="/pos"
              className="inline-flex min-h-[44px] items-center rounded-md border border-border-strong bg-surface-raised px-4 text-sm font-semibold text-ink"
              onClick={() => setStoreId(store.id)}
            >
              POS
            </Link>
          )}
          {store.locationType !== "WAREHOUSE" && (
            <Link
              to="/settlement"
              className="inline-flex min-h-[44px] items-center rounded-md border border-border-strong bg-surface-raised px-4 text-sm font-semibold text-ink"
              onClick={() => setStoreId(store.id)}
            >
              Settlement
            </Link>
          )}
        </span>
      ),
    },
  ];

  const warehouseColumns: DataTableColumn<StoreRow>[] = [
    {
      id: "store",
      header: "Warehouse",
      cell: (store) => (
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">{store.name}</span>
            <StatusBadge label="Warehouse" tone="neutral" />
          </div>
          <div className="text-xs text-ink-muted">{store.address}</div>
        </div>
      ),
    },
    {
      id: "alerts",
      header: "Stock alerts",
      numeric: true,
      cell: (store) => <span className="tabular text-ink">{store.stockAlertCount}</span>,
    },
    {
      id: "actions",
      header: "Actions",
      cell: (store) => (
        <Button type="button" variant="quiet" onClick={() => openStoreDashboard(store.id)}>
          Open inventory
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Network overview"
        description="COOP_ADMIN view across every store. Use Switch store in the header (or Open store below) before POS, Inventory, or Settlement for a specific location."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
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
        <Link to="/shrinkage?scope=network" className="block rounded-lg">
          <StatCard
            label="Shrinkage rate · 30 days"
            value={shrinkage ? formatRate(networkShrinkageRate) : "…"}
            subLine={
              shrinkage ? (
                <>
                  {formatMoney(shrinkage.comparison.networkValue)} lost of{" "}
                  {formatMoney(shrinkage.comparison.networkSalesAtCost)} sold at cost
                </>
              ) : undefined
            }
          />
        </Link>
      </div>

      <DataTable
        columns={columns}
        rows={stores}
        rowKey={(s) => s.id}
        emptyMessage={storesQuery.isLoading ? "Loading stores…" : "No retail stores yet."}
      />

      {warehouses.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-ink">Warehouses</h2>
          <p className="text-sm text-ink-muted">
            Co-op operated — no POS or operator payout. Inventory, counts, and shrinkage still apply.
          </p>
          <DataTable
            columns={warehouseColumns}
            rows={warehouses}
            rowKey={(s) => s.id}
            emptyMessage="No warehouses."
          />
        </div>
      )}

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-ink">Supplier certifications · next 30 days</h2>
        <p className="text-sm text-ink-muted">
          Expiring certificates and FSVP reviews due soon. Flagged daily by the compliance job.
        </p>
        {certsQuery.isLoading ? (
          <p className="text-sm text-ink-muted">Loading certifications…</p>
        ) : expiringCerts.length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing due in the next 30 days.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border bg-surface-raised">
            {expiringCerts.map((row) => (
              <li
                key={`${row.id}-${row.reason}`}
                className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3"
              >
                <div>
                  <div className="font-medium text-ink">
                    {row.supplierName}{" "}
                    <span className="text-sm font-normal text-ink-muted">· {row.certType}</span>
                  </div>
                  <div className="text-xs text-ink-muted">
                    {row.certNumber || "No number"} ·{" "}
                    {row.reason === "EXPIRING" ? "Expires" : "Review due"}{" "}
                    {(row.reason === "EXPIRING" ? row.expiresAt : row.nextReviewDue)?.slice(0, 10)}
                  </div>
                </div>
                <StatusBadge
                  label={
                    row.daysUntil < 0
                      ? `${Math.abs(row.daysUntil)}d overdue`
                      : row.daysUntil === 0
                        ? "Due today"
                        : `${row.daysUntil}d`
                  }
                  tone={row.daysUntil <= 7 ? "warning" : "neutral"}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
