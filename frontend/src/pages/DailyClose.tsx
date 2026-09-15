/**
 * Daily close (Z-report) — night sign-off for store operators.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, money } from "../api/client";
import type { DailyCloseReport } from "../api/types";
import { useAuth } from "../auth/AuthContext";

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

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
    return <p className="text-stone-600">Select a store.</p>;
  }

  const report = reportQuery.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Daily close</h1>
          <p className="text-sm text-stone-600">Z-report for operator night sign-off</p>
        </div>
        <label className="text-sm">
          Date (UTC)
          <input
            type="date"
            className="ml-2 rounded border border-stone-300 px-2 py-1"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
      </div>

      {reportQuery.isLoading && <p>Loading…</p>}
      {report && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(report.salesByPaymentMethod).map(([method, amt]) => (
              <div key={method} className="rounded-lg border border-stone-200 bg-white p-4">
                <p className="text-sm text-stone-500">{method}</p>
                <p className="mt-1 text-xl font-semibold">{money(amt)}</p>
              </div>
            ))}
            <div className="rounded-lg border border-stone-200 bg-white p-4">
              <p className="text-sm text-stone-500">Tax collected</p>
              <p className="mt-1 text-xl font-semibold">{money(report.taxCollected)}</p>
            </div>
            <div className="rounded-lg border border-stone-200 bg-white p-4">
              <p className="text-sm text-stone-500">Refunds</p>
              <p className="mt-1 text-xl font-semibold">{money(report.refundsTotal)}</p>
            </div>
            <div className="rounded-lg border border-stone-200 bg-white p-4">
              <p className="text-sm text-stone-500">Operator share accrued</p>
              <p className="mt-1 text-xl font-semibold">{money(report.operatorShareAccrued)}</p>
            </div>
            <div className="rounded-lg border border-stone-200 bg-white p-4">
              <p className="text-sm text-stone-500">Cash variance</p>
              <p className="mt-1 text-xl font-semibold">
                {report.cashVariance == null ? "—" : money(report.cashVariance)}
              </p>
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b bg-stone-50 text-stone-600">
                <tr>
                  <th className="px-3 py-2">Cashier</th>
                  <th className="px-3 py-2">Sales</th>
                  <th className="px-3 py-2">Gross</th>
                  <th className="px-3 py-2">Operator share</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {report.cashierBreakdown.map((row) => (
                  <tr key={row.cashierId}>
                    <td className="px-3 py-2">{row.email}</td>
                    <td className="px-3 py-2">{row.saleCount}</td>
                    <td className="px-3 py-2">{money(row.grossSales)}</td>
                    <td className="px-3 py-2">{money(row.operatorShare)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
