/**
 * Store settings page.
 *
 * APIs:
 * - GET /stores/:id — load store (CASHIER/STORE_ADMIN/COOP_ADMIN for accessible stores)
 * - PATCH /stores/:id — update name/address (STORE_ADMIN, COOP_ADMIN)
 *
 * operatorPercent is editable only for COOP_ADMIN.
 * Why: changing operatorPercent must NOT rewrite past sales. Each Sale stores a snapshot
 * of operatorPercent / operatorAmount at checkout (Phases 1 & 4). Edits here only affect
 * FUTURE sales. Store admins can rename the store but cannot alter the commission rate.
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "../api/client.ts";
import type { Store } from "../api/types.ts";
import { useAuth } from "../auth/AuthContext.tsx";

function StoreSettingsForm({ store }: { store: Store }) {
  const { activeStoreId, isRole } = useAuth();
  const canEditPercent = isRole("COOP_ADMIN");
  const qc = useQueryClient();
  const [name, setName] = useState(store.name);
  const [address, setAddress] = useState(store.address);
  const [operatorPercent, setOperatorPercent] = useState(String(store.operatorPercent));
  const [taxRate, setTaxRate] = useState(String(store.taxRate ?? 0));
  const [refundPolicy, setRefundPolicy] = useState(store.refundPolicy ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const saveMutation = useMutation({
    mutationFn: () => {
      const body: Record<string, string | number> = {
        name,
        address,
        taxRate: Number(taxRate),
        refundPolicy,
      };
      if (canEditPercent) {
        body.operatorPercent = Number(operatorPercent);
      }
      return apiRequest<{ store: Store }>(`/stores/${activeStoreId}`, {
        method: "PATCH",
        body,
      });
    },
    onSuccess: () => {
      setMessage("Store settings saved. New operatorPercent applies to future sales only.");
      setError(null);
      void qc.invalidateQueries({ queryKey: ["store"] });
      void qc.invalidateQueries({ queryKey: ["stores"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Save failed"),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    saveMutation.mutate();
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-lg border border-stone-200 bg-white p-4"
    >
      <label className="block text-sm">
        Store name
        <input
          className="mt-1 w-full rounded border border-stone-300 px-3 py-2"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </label>
      <label className="block text-sm">
        Address
        <input
          className="mt-1 w-full rounded border border-stone-300 px-3 py-2"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          required
        />
      </label>
      <label className="block text-sm">
        Operator percent
        <input
          type="number"
          min={0}
          max={100}
          step="0.01"
          className="mt-1 w-full rounded border border-stone-300 px-3 py-2 disabled:bg-stone-100"
          value={operatorPercent}
          onChange={(e) => setOperatorPercent(e.target.value)}
          disabled={!canEditPercent}
          required
        />
        <span className="mt-1 block text-xs text-stone-500">
          {canEditPercent
            ? "COOP_ADMIN only. Changing this does not recalculate past sales — each sale already snapshotted its operatorPercent. Operator % applies to PRE-TAX subtotal only."
            : "Only COOP_ADMIN can change the operator commission rate."}
        </span>
      </label>
      <label className="block text-sm">
        Tax rate (%)
        <input
          type="number"
          min={0}
          max={100}
          step="0.01"
          className="mt-1 w-full rounded border border-stone-300 px-3 py-2"
          value={taxRate}
          onChange={(e) => setTaxRate(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        Receipt refund policy
        <textarea
          className="mt-1 w-full rounded border border-stone-300 px-3 py-2"
          rows={3}
          value={refundPolicy}
          onChange={(e) => setRefundPolicy(e.target.value)}
        />
      </label>
      <button type="submit" className="rounded bg-stone-900 px-4 py-2 text-white">
        Save
      </button>
      {message && <p className="text-sm text-green-800">{message}</p>}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </form>
  );
}

export function SettingsPage() {
  const { activeStoreId } = useAuth();

  const storeQueryResult = useQuery({
    queryKey: ["store", activeStoreId],
    enabled: !!activeStoreId,
    queryFn: () => apiRequest<{ store: Store }>(`/stores/${activeStoreId}`),
  });

  if (!activeStoreId) {
    return <p className="text-stone-600">Select a store to edit settings.</p>;
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Store settings</h1>
      {storeQueryResult.isLoading && <p>Loading…</p>}
      {storeQueryResult.data?.store && (
        <StoreSettingsForm
          key={storeQueryResult.data.store.id}
          store={storeQueryResult.data.store}
        />
      )}
    </div>
  );
}
