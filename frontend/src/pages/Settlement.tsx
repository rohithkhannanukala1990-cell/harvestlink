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
import { ApiError, apiRequest, money } from "../api/client";
import type { Payout, SettlementSummary } from "../api/types";
import { useAuth } from "../auth/AuthContext";

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
    return <p className="text-stone-600">Select a store to view settlement.</p>;
  }

  const summary = summaryQuery.data;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settlement</h1>
      <p className="text-sm text-stone-600">
        Internal ledger of what the co-op owes the store operator (not a Stripe payout).
      </p>

      <div className="grid gap-4 sm:grid-cols-4">
        {(
          [
            ["Gross sales", summary?.grossSales],
            ["Operator accrued", summary?.operatorAccrued],
            ["Paid out", summary?.totalPaidOut],
            ["Currently owed", summary?.currentlyOwed],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="rounded-lg border border-stone-200 bg-white p-4">
            <p className="text-sm text-stone-500">{label}</p>
            <p className="mt-2 text-xl font-semibold">{money(value ?? 0)}</p>
          </div>
        ))}
      </div>

      <form
        onSubmit={onSubmit}
        className="grid max-w-xl gap-3 rounded-lg border border-stone-200 bg-white p-4 sm:grid-cols-2"
      >
        <h2 className="sm:col-span-2 font-medium">Record payout</h2>
        <label className="text-sm">
          Amount
          <input
            type="number"
            min="0.01"
            step="0.01"
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </label>
        <label className="text-sm">
          Note
          <input
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Weekly transfer"
          />
        </label>
        <div className="sm:col-span-2">
          <button type="submit" className="rounded bg-stone-900 px-4 py-2 text-white">
            Save payout
          </button>
          {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
        </div>
      </form>

      <section>
        <h2 className="mb-2 font-medium">Payout history</h2>
        <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white">
          {(payoutsQuery.data?.payouts ?? []).map((p) => (
            <li key={p.id} className="flex justify-between px-4 py-3 text-sm">
              <span>
                {new Date(p.createdAt).toLocaleString()}
                {p.note ? ` · ${p.note}` : ""}
              </span>
              <span className="font-medium">{money(p.amount)}</span>
            </li>
          ))}
          {payoutsQuery.data?.payouts.length === 0 && (
            <li className="px-4 py-3 text-sm text-stone-500">No payouts yet.</li>
          )}
        </ul>
      </section>
    </div>
  );
}
