/**
 * Shrinkage — losses as a rate of sales at cost, not as isolated incidents.
 *
 * APIs:
 * - GET /reports/shrinkage?storeId&from&to (STORE_ADMIN own store; COOP_ADMIN any store or the
 *   whole network when storeId is omitted)
 *
 * Expiry write-offs, refunds not restocked, recalls, count shortfalls and manual adjustments are
 * already folded into one figure by the API. Offline stock conflicts are shown beside it, not in it.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import type { ShrinkageReport } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import {
  SHRINKAGE_REASON_LABELS,
  SHRINKAGE_SOURCE_LABELS,
  fetchShrinkage,
  formatRate,
  shrinkageRateTone,
} from "../components/ShrinkageRate";
import {
  Card,
  DataTable,
  Field,
  Money,
  PageHeader,
  SelectField,
  StatCard,
  StatusBadge,
  formatMoney,
  type DataTableColumn,
} from "../components/ui";

type ReasonRow = ShrinkageReport["byReason"][number];
type SourceRow = ShrinkageReport["bySource"][number];
type ProductRow = ShrinkageReport["byProduct"][number];
type CategoryRow = ShrinkageReport["byCategory"][number];
type LotRow = ShrinkageReport["byLot"][number];
type SupplierRow = ShrinkageReport["bySupplier"][number];
type TrendRow = ShrinkageReport["trend"][number];
type StoreRow = ShrinkageReport["comparison"]["stores"][number];
type ConflictRow = ShrinkageReport["offlineStockConflicts"]["products"][number];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dayUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Highlights a rate above the one it is compared with (network, or the overall rate in scope). */
function RateCell({ rate, networkRate }: { rate: string | null; networkRate?: string | null }) {
  const above = shrinkageRateTone(rate, networkRate) === "warning";
  return (
    <span className={`tabular ${above ? "font-semibold text-state-warning" : "text-ink"}`}>
      {formatRate(rate)}
      {above && (
        <span className="ml-1 text-xs" title={`Above ${formatRate(networkRate ?? null)}`}>
          ▲ above
        </span>
      )}
    </span>
  );
}

function ShareBar({ percent }: { percent: number }) {
  return (
    <div className="h-2 w-24 overflow-hidden rounded bg-surface-sunken" aria-hidden>
      <div className="h-full bg-brand-terracotta" style={{ width: `${Math.min(100, percent)}%` }} />
    </div>
  );
}

const unitsColumn = <T extends { units: number }>(): DataTableColumn<T> => ({
  id: "units",
  header: "Units",
  numeric: true,
  cell: (r) => <span className="tabular">{r.units}</span>,
});

const valueColumn = <T extends { value: string }>(): DataTableColumn<T> => ({
  id: "value",
  header: "Value lost",
  numeric: true,
  cell: (r) => <Money value={r.value} tone="alert" />,
});

function rateColumns<T extends ProductRow | CategoryRow | SupplierRow | StoreRow>(
  networkRate: string | null,
): DataTableColumn<T>[] {
  return [
    {
      id: "sales",
      header: "Sales at cost",
      numeric: true,
      cell: (r) => <Money value={r.salesAtCost} />,
    },
    {
      id: "rate",
      header: "Rate",
      numeric: true,
      cell: (r) => <RateCell rate={r.ratePercent} networkRate={networkRate} />,
    },
  ];
}

function productLabel(r: { productName: string; sku: string }) {
  return (
    <span>
      {r.productName} <span className="font-mono text-ink-muted">({r.sku})</span>
    </span>
  );
}

function TrendChart({ trend, granularity }: { trend: TrendRow[]; granularity: string }) {
  const rates = trend.flatMap((t) => [t.ratePercent, t.networkRatePercent]);
  const max = Math.max(1, ...rates.map((r) => (r == null ? 0 : Number(r))));
  return (
    <div className="space-y-2">
      <div className="flex h-40 items-end gap-1 border-b border-border-hairline" role="img" aria-label={`Shrinkage rate by ${granularity}`}>
        {trend.map((t) => {
          const rate = t.ratePercent == null ? 0 : Number(t.ratePercent);
          const net = t.networkRatePercent == null ? null : Number(t.networkRatePercent);
          return (
            <div
              key={t.bucketStart}
              className="relative flex h-full flex-1 items-end"
              title={`${t.bucketStart}: ${formatRate(t.ratePercent)} (network ${formatRate(t.networkRatePercent)}) · ${formatMoney(t.value)} lost`}
            >
              <div
                className={`w-full rounded-t ${t.ratePercent == null ? "" : "bg-brand-terracotta"}`}
                style={{ height: `${(rate / max) * 100}%` }}
              />
              {net != null && (
                <div
                  className="absolute inset-x-0 border-t-2 border-dashed border-brand-green"
                  style={{ bottom: `${(net / max) * 100}%` }}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-xs text-ink-muted">
        <span>{trend[0]?.bucketStart}</span>
        <span className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-sm bg-brand-terracotta" /> This scope
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-3 border-t-2 border-dashed border-brand-green" /> Network
          </span>
          <span>peak {max.toFixed(2)}%</span>
        </span>
        <span>{trend[trend.length - 1]?.bucketStart}</span>
      </div>
    </div>
  );
}

export function ShrinkagePage() {
  const { activeStoreId, isRole } = useAuth();
  const isCoop = isRole("COOP_ADMIN");
  const [to, setTo] = useState(() => dayUtc(new Date()));
  const [from, setFrom] = useState(() => dayUtc(new Date(Date.now() - 29 * MS_PER_DAY)));
  const [searchParams] = useSearchParams();
  const [scope, setScope] = useState<"store" | "network">(
    searchParams.get("scope") === "network" ? "network" : "store",
  );

  const storeId = isCoop && scope === "network" ? null : activeStoreId;
  const needsStore = !isCoop || scope === "store";

  const reportQuery = useQuery({
    queryKey: ["shrinkage", storeId, from, to],
    enabled: !needsStore || !!activeStoreId,
    queryFn: () => fetchShrinkage({ storeId, from, to }),
  });

  const report = reportQuery.data;
  const networkRate = report?.comparison.networkRatePercent ?? null;
  const isNetworkScope = report != null && report.storeId == null;
  const compareRate = isNetworkScope ? null : networkRate;

  const reasonColumns: DataTableColumn<ReasonRow>[] = [
    {
      id: "reason",
      header: "Reason",
      cell: (r) => SHRINKAGE_REASON_LABELS[r.reason] ?? r.reason,
    },
    { id: "events", header: "Events", numeric: true, cell: (r) => <span className="tabular">{r.events}</span> },
    unitsColumn<ReasonRow>(),
    valueColumn<ReasonRow>(),
    {
      id: "share",
      header: "Share",
      numeric: true,
      cell: (r) => (
        <span className="inline-flex items-center justify-end gap-2">
          <ShareBar percent={Number(r.sharePercent)} />
          <span className="tabular w-14">{r.sharePercent}%</span>
        </span>
      ),
    },
  ];

  const sourceColumns: DataTableColumn<SourceRow>[] = [
    { id: "source", header: "Recorded by", cell: (r) => SHRINKAGE_SOURCE_LABELS[r.source] ?? r.source },
    { id: "events", header: "Events", numeric: true, cell: (r) => <span className="tabular">{r.events}</span> },
    unitsColumn<SourceRow>(),
    valueColumn<SourceRow>(),
  ];

  const supplierColumns: DataTableColumn<SupplierRow>[] = [
    {
      id: "supplier",
      header: "Supplier / FPO",
      cell: (r) => (
        <span className={r.supplierId ? "text-ink" : "text-ink-muted"}>{r.supplierName}</span>
      ),
    },
    unitsColumn<SupplierRow>(),
    valueColumn<SupplierRow>(),
    ...rateColumns<SupplierRow>(report?.totals.ratePercent ?? null),
  ];

  const categoryColumns: DataTableColumn<CategoryRow>[] = [
    { id: "category", header: "Category", cell: (r) => r.category },
    unitsColumn<CategoryRow>(),
    valueColumn<CategoryRow>(),
    ...rateColumns<CategoryRow>(report?.totals.ratePercent ?? null),
  ];

  const productColumns: DataTableColumn<ProductRow>[] = [
    { id: "product", header: "Product", cell: productLabel },
    { id: "category", header: "Category", cell: (r) => <span className="text-ink-muted">{r.category}</span> },
    unitsColumn<ProductRow>(),
    valueColumn<ProductRow>(),
    ...rateColumns<ProductRow>(report?.totals.ratePercent ?? null),
  ];

  const lotColumns: DataTableColumn<LotRow>[] = [
    { id: "lot", header: "Lot", cell: (r) => <span className="font-mono">{r.lotNumber}</span> },
    { id: "product", header: "Product", cell: productLabel },
    {
      id: "supplier",
      header: "Supplier / FPO",
      cell: (r) => r.supplierName ?? <span className="text-ink-muted">—</span>,
    },
    { id: "events", header: "Events", numeric: true, cell: (r) => <span className="tabular">{r.events}</span> },
    unitsColumn<LotRow>(),
    valueColumn<LotRow>(),
  ];

  const storeColumns: DataTableColumn<StoreRow>[] = [
    { id: "store", header: "Store", cell: (r) => <span className="font-semibold">{r.storeName}</span> },
    unitsColumn<StoreRow>(),
    valueColumn<StoreRow>(),
    ...rateColumns<StoreRow>(networkRate),
  ];

  const trendColumns: DataTableColumn<TrendRow>[] = [
    { id: "bucket", header: "Period from", cell: (r) => <span className="tabular">{r.bucketStart}</span> },
    unitsColumn<TrendRow>(),
    valueColumn<TrendRow>(),
    { id: "sales", header: "Sales at cost", numeric: true, cell: (r) => <Money value={r.salesAtCost} /> },
    { id: "rate", header: "Rate", numeric: true, cell: (r) => <RateCell rate={r.ratePercent} networkRate={r.networkRatePercent} /> },
    { id: "network", header: "Network rate", numeric: true, cell: (r) => <span className="tabular text-ink-muted">{formatRate(r.networkRatePercent)}</span> },
  ];

  const conflictColumns: DataTableColumn<ConflictRow>[] = [
    { id: "product", header: "Product", cell: productLabel },
    { id: "rows", header: "Offline sales", numeric: true, cell: (r) => <span className="tabular">{r.rows}</span> },
    { id: "open", header: "Unresolved", numeric: true, cell: (r) => <span className="tabular">{r.open}</span> },
    { id: "units", header: "Units oversold", numeric: true, cell: (r) => <span className="tabular">{r.unitsOversold}</span> },
  ];

  if (needsStore && !activeStoreId) {
    return <p className="text-ink-muted">Select a store, or switch to the whole network.</p>;
  }

  const scopeLabel = isNetworkScope ? "Network" : (report?.storeName ?? "This store");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Shrinkage"
        description="Stock lost without a sale, as a share of what was sold at cost. Compare the rate, not the raw value — value grows with volume."
        actions={
          <div className="flex flex-wrap items-end gap-3">
            {isCoop && (
              <SelectField
                label="Scope"
                value={scope}
                onChange={(e) => setScope(e.target.value as "store" | "network")}
              >
                <option value="store">Selected store</option>
                <option value="network">Whole network</option>
              </SelectField>
            )}
            <Field label="From (UTC)" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            <Field label="To (UTC)" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </div>
        }
      />

      {reportQuery.isLoading && <p className="text-ink-muted">Loading…</p>}
      {reportQuery.isError && (
        <p className="text-state-danger" role="alert">
          {reportQuery.error instanceof Error ? reportQuery.error.message : "Could not load the report."}
        </p>
      )}

      {report && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label={`Shrinkage rate · ${scopeLabel}`}
              value={formatRate(report.totals.ratePercent)}
              subLine={
                isNetworkScope ? (
                  <>of sales at cost, {report.from} to {report.to}</>
                ) : (
                  <>Network {formatRate(networkRate)}</>
                )
              }
              tone={shrinkageRateTone(report.totals.ratePercent, compareRate)}
            />
            <StatCard
              label="Value lost"
              value={formatMoney(report.totals.value)}
              subLine={
                <>
                  <span className="tabular">{report.totals.units}</span> units ·{" "}
                  <span className="tabular">{report.totals.events}</span> events
                </>
              }
              tone={Number(report.totals.value) > 0 ? "alert" : "default"}
            />
            <StatCard label="Sales at cost" value={formatMoney(report.totals.salesAtCost)} subLine="net of refunds" />
            <StatCard
              label="Count overages"
              value={formatMoney(report.totals.countOverageValue)}
              subLine={
                <>
                  <span className="tabular">{report.totals.countOverageUnits}</span> units found — not
                  netted off losses
                </>
              }
            />
          </div>

          <Card title={`Trend by ${report.granularity}`}>
            {report.trend.length > 0 ? (
              <TrendChart trend={report.trend} granularity={report.granularity} />
            ) : (
              <p className="text-ink-muted">No periods in range.</p>
            )}
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-semibold text-ink">Show as table</summary>
              <div className="mt-2">
                <DataTable columns={trendColumns} rows={report.trend} rowKey={(r) => r.bucketStart} />
              </div>
            </details>
          </Card>

          <Card title="Store versus network">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-sm text-ink-muted">{isNetworkScope ? "Network" : scopeLabel}</p>
                <p className="tabular text-2xl font-bold">
                  <RateCell rate={report.totals.ratePercent} networkRate={compareRate} />
                </p>
              </div>
              <div>
                <p className="text-sm text-ink-muted">Network rate</p>
                <p className="tabular text-2xl font-bold text-ink">{formatRate(networkRate)}</p>
              </div>
              <div>
                <p className="text-sm text-ink-muted">Network value lost / sales at cost</p>
                <p className="tabular text-lg text-ink">
                  {formatMoney(report.comparison.networkValue)} / {formatMoney(report.comparison.networkSalesAtCost)}
                </p>
              </div>
            </div>
            {report.comparison.stores.length > 0 && (
              <div className="mt-4">
                <DataTable
                  columns={storeColumns}
                  rows={report.comparison.stores}
                  rowKey={(r) => r.storeId}
                  emptyMessage="No stores"
                />
              </div>
            )}
          </Card>

          <Card title="Top loss products">
            <DataTable
              columns={productColumns}
              rows={report.topLossProducts}
              rowKey={(r) => r.productId}
              emptyMessage="No losses recorded in this range."
            />
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="By reason">
              <DataTable
                columns={reasonColumns}
                rows={report.byReason}
                rowKey={(r) => r.reason}
                emptyMessage="No losses recorded."
              />
            </Card>
            <Card title="Where the figures come from">
              <p className="mb-3 text-sm text-ink-muted">
                Each loss is counted once, from the record that already exists for it.
              </p>
              <DataTable
                columns={sourceColumns}
                rows={report.bySource}
                rowKey={(r) => r.source}
                emptyMessage="No losses recorded."
              />
            </Card>
          </div>

          <Card title="By supplier / FPO">
            <p className="mb-3 text-sm text-ink-muted">
              Losses concentrated in one supplier's goods can point to packaging, transit or shelf
              life at source rather than a store problem. Rate is that supplier's losses over their
              goods' sales at cost.
            </p>
            <DataTable
              columns={supplierColumns}
              rows={report.bySupplier}
              rowKey={(r) => r.supplierId ?? "none"}
              emptyMessage="No losses recorded."
            />
          </Card>

          <Card title="By category">
            <DataTable
              columns={categoryColumns}
              rows={report.byCategory}
              rowKey={(r) => r.category}
              emptyMessage="No losses recorded."
            />
          </Card>

          <Card title="By lot">
            <DataTable
              columns={lotColumns}
              rows={report.byLot}
              rowKey={(r) => r.lotId}
              emptyMessage="No lot-level losses recorded."
            />
          </Card>

          <Card title="All products with losses">
            <DataTable
              columns={productColumns}
              rows={report.byProduct}
              rowKey={(r) => r.productId}
              emptyMessage="No losses recorded."
            />
          </Card>

          <Card
            title="Offline stock conflicts"
            actions={
              report.offlineStockConflicts.open > 0 ? (
                <StatusBadge label={`${report.offlineStockConflicts.open} unresolved`} tone="warning" />
              ) : undefined
            }
          >
            <p className="mb-3 text-sm text-ink-muted">
              Offline sales that took stock below zero. These goods were sold, so they are not in the
              loss figure above; the books are corrected by the next count, which shows here as a
              count adjustment if anything was really missing.{" "}
              <span className="tabular">{report.offlineStockConflicts.unitsOversold}</span> units
              oversold across <span className="tabular">{report.offlineStockConflicts.rows}</span>{" "}
              sales.
            </p>
            <DataTable
              columns={conflictColumns}
              rows={report.offlineStockConflicts.products}
              rowKey={(r) => r.productId}
              emptyMessage="No offline stock conflicts in this range."
            />
          </Card>
        </div>
      )}
    </div>
  );
}
