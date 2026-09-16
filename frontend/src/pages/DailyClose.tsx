/**
 * Daily close (Z-report) — night sign-off for store operators.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../api/client";
import type { DailyCloseReport } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import {
  DataTable,
  Field,
  Money,
  PageHeader,
  StatCard,
  formatMoney,
  type DataTableColumn,
} from "../components/ui";

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

type CashierRow = DailyCloseReport["cashierBreakdown"][number];

export function DailyClosePage() {
  const { activeStoreId } = useAuth();
  const [date, setDate] = useState(todayUtc());

  const queryString = useMemo(() => {
    const params = new URLSearchParams({ date });
    if (activeStoreId) params.set("storeId", activeStoreId);
    return params.toString();
  }, [date, activeStoreId]);

  const reportQuery = useQuery({
    queryKey: ["daily-close", queryString],
    enabled: !!activeStoreId,
    queryFn: () => apiRequest<DailyCloseReport>(`/reports/daily-close?${queryString}`),
  });

  if (!activeStoreId) {
    return <p className="text-ink-muted">Select a store.</p>;
  }

  const report = reportQuery.data;

  const cashierColumns: DataTableColumn<CashierRow>[] = [
    { id: "email", header: "Cashier", cell: (row) => row.email },
    {
      id: "sales",
      header: "Sales",
      numeric: true,
      cell: (row) => <span className="tabular">{row.saleCount}</span>,
    },
    {
      id: "gross",
      header: "Gross",
      numeric: true,
      cell: (row) => <Money value={row.grossSales} />,
    },
    {
      id: "share",
      header: "Operator share",
      numeric: true,
      cell: (row) => <Money value={row.operatorShare} />,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Daily close"
        description="Z-report for operator night sign-off"
        actions={
          <Field
            label="Date (UTC)"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        }
      />

      {reportQuery.isLoading && <p className="text-ink-muted">Loading…</p>}
      {report && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(report.salesByPaymentMethod).map(([method, amt]) => (
              <StatCard key={method} label={method} value={formatMoney(amt)} />
            ))}
            <StatCard label="Tax collected" value={formatMoney(report.taxCollected)} />
            <StatCard label="Refunds" value={formatMoney(report.refundsTotal)} />
            <StatCard
              label="Operator share accrued"
              value={formatMoney(report.operatorShareAccrued)}
            />
            <StatCard
              label="Cash variance"
              value={
                report.cashVariance == null ? "—" : formatMoney(report.cashVariance)
              }
              tone={
                report.cashVariance != null && Number(report.cashVariance) !== 0
                  ? "alert"
                  : "default"
              }
            />
          </div>

          <DataTable
            columns={cashierColumns}
            rows={report.cashierBreakdown}
            rowKey={(row) => row.cashierId}
            emptyMessage="No cashier activity"
          />
        </div>
      )}
    </div>
  );
}
