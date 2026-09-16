/**
 * Settlement page — operator payables for the active store.
 *
 * APIs:
 * - GET /settlement/:storeId/summary — accrued vs paid (STORE_ADMIN own store, COOP_ADMIN any)
 * - GET /settlement/:storeId/payouts — payout history (same roles)
 * - POST /settlement/:storeId/payouts — record payout { amount, note } (same roles)
 *
 * Cashiers cannot access this route (nav + route guard).
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "../api/client";
import type { Payout, SettlementSummary } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import {
  Button,
  Card,
  DataTable,
  Field,
  Money,
  PageHeader,
  StatCard,
  formatMoney,
  type DataTableColumn,
} from "../components/ui";

export function SettlementPage() {
  const { activeStoreId } = useAuth();
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const summaryQuery = useQuery({
    queryKey: ["settlement", activeStoreId],
    enabled: !!activeStoreId,
    queryFn: () =>
      apiRequest<SettlementSummary>(`/settlement/${activeStoreId}/summary`),
  });

  const payoutsQuery = useQuery({
    queryKey: ["payouts", activeStoreId],
    enabled: !!activeStoreId,
    queryFn: () =>
      apiRequest<{ payouts: Payout[]; total: number }>(
        `/settlement/${activeStoreId}/payouts?page=1&pageSize=50`,
      ),
  });

  const payoutMutation = useMutation({
    mutationFn: () =>
      apiRequest<{ payout: Payout; summary: SettlementSummary }>(
        `/settlement/${activeStoreId}/payouts`,
        {
          method: "POST",
          body: { amount: Number(amount), note: note || null },
        },
      ),
    onSuccess: () => {
      setAmount("");
      setNote("");
      setError(null);
      void qc.invalidateQueries({ queryKey: ["settlement"] });
      void qc.invalidateQueries({ queryKey: ["payouts"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Payout failed"),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    payoutMutation.mutate();
  }

  if (!activeStoreId) {
    return <p className="text-ink-muted">Select a store to view settlement.</p>;
  }

  const summary = summaryQuery.data;
  const payouts = payoutsQuery.data?.payouts ?? [];

  const payoutColumns: DataTableColumn<Payout>[] = [
    {
      id: "when",
      header: "When",
      cell: (p) => (
        <span>
          {new Date(p.createdAt).toLocaleString()}
          {p.note ? ` · ${p.note}` : ""}
        </span>
      ),
    },
    {
      id: "amount",
      header: "Amount",
      numeric: true,
      cell: (p) => <Money value={p.amount} />,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settlement"
        description="Internal ledger of what the co-op owes the store operator (not a Stripe payout). Trading shares in ink; amounts owed in alert."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Gross sales"
          value={formatMoney(summary?.grossSales ?? 0)}
        />
        <StatCard
          label="Operator share accrued"
          value={formatMoney(summary?.operatorAccrued ?? 0)}
        />
        <StatCard
          label="Paid out"
          value={formatMoney(summary?.totalPaidOut ?? 0)}
        />
        <StatCard
          label="Currently owed"
          value={formatMoney(summary?.currentlyOwed ?? 0)}
          tone="alert"
        />
      </div>

      <Card title="Record payout">
        <form onSubmit={onSubmit} className="grid max-w-xl gap-3 sm:grid-cols-2">
          <Field
            label="Amount"
            type="number"
            min="0.01"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
          <Field
            label="Note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Weekly transfer"
          />
          <div className="sm:col-span-2">
            <Button type="submit" loading={payoutMutation.isPending}>
              Save payout
            </Button>
            {error && (
              <p className="mt-2 text-sm text-state-danger" role="alert">
                {error}
              </p>
            )}
          </div>
        </form>
      </Card>

      <section className="space-y-2">
        <h2 className="font-semibold text-ink">Payout history</h2>
        <DataTable
          columns={payoutColumns}
          rows={payouts}
          rowKey={(p) => p.id}
          emptyMessage="No payouts yet."
        />
      </section>
    </div>
  );
}
