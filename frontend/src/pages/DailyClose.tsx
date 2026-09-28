/**
 * Daily close (Z-report) — night sign-off for store operators.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../api/client";
import type { DailyCloseReport, VarianceShift } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { SignedMoney, VariancePatterns } from "../components/DrawerVariance";
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

const shiftColumns: DataTableColumn<VarianceShift>[] = [
  { id: "user", header: "Opened by", cell: (s) => s.userEmail },
  { id: "closer", header: "Closed by", cell: (s) => s.closedByEmail ?? "—" },
  {
    id: "closed",
    header: "Closed",
    cell: (s) => (
      <span className="whitespace-nowrap text-ink-muted">
        {new Date(s.closedAt).toLocaleTimeString()}
      </span>
    ),
  },
  { id: "expected", header: "Expected", numeric: true, cell: (s) => <Money value={s.expectedCash} /> },
  { id: "counted", header: "Counted", numeric: true, cell: (s) => <Money value={s.countedCash} /> },
  {
    id: "variance",
    header: "Variance",
    numeric: true,
    cell: (s) => <SignedMoney value={s.variance} emphasize={s.overThreshold} />,
  },
];

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

          <section className="space-y-2">
            <h2 className="font-semibold text-ink">Drawer shifts</h2>
            <p className="text-sm text-ink-muted">
              Variances above {formatMoney(report.drawerVariance.threshold)} are highlighted.
            </p>
            <DataTable
              columns={shiftColumns}
              rows={report.drawerVariance.shifts}
              rowKey={(s) => s.drawerId}
              emptyMessage="No drawers closed on this date"
            />
          </section>

          <VariancePatterns
            patterns={report.drawerVariance.patterns}
            windowLabel={`${report.drawerVariance.windowFrom} to ${report.drawerVariance.windowTo}`}
          />
        </div>
      )}
    </div>
  );
}
