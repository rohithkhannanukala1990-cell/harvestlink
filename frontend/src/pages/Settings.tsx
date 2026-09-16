/**
 * Store + cooperative settings page.
 *
 * APIs:
 * - GET /stores/:id — load store (CASHIER/STORE_ADMIN/COOP_ADMIN for accessible stores)
 * - PATCH /stores/:id — update name/address (STORE_ADMIN, COOP_ADMIN)
 *
 * operatorPercent is editable only for COOP_ADMIN.
 * Why: changing operatorPercent must NOT rewrite past sales. Each Sale stores a snapshot
 * of operatorPercent / operatorAmount at checkout (Phases 1 & 4). Edits here only affect
 * FUTURE sales. Store admins can rename the store but cannot alter the commission rate.
 *
 * Cooperative settings (voting threshold, discount bearer) are grouped separately from
 * store-local fields. Voting threshold lives in CooperativeSettings on the server; discount
 * bearer is returned on the store record for display. No new save endpoints added here.
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "../api/client.ts";
import type { Store } from "../api/types.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import {
  Button,
  Card,
  Field,
  PageHeader,
  StatusBadge,
} from "../components/ui";

function StoreSettingsForm({ store }: { store: Store }) {
  const { activeStoreId, isRole } = useAuth();
  const canEditPercent = isRole("COOP_ADMIN");
  const isCoop = isRole("COOP_ADMIN");
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

  const bearer = store.memberDiscountBearer ?? "COOP";

  return (
    <div className="space-y-6">
      <Card title="Store settings">
        <form onSubmit={onSubmit} className="space-y-4">
          <Field
            label="Store name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <Field
            label="Address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            required
          />
          <Field
            label="Tax rate (%)"
            type="number"
            min={0}
            max={100}
            step="0.01"
            value={taxRate}
            onChange={(e) => setTaxRate(e.target.value)}
          />
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-semibold text-ink">Receipt refund policy</span>
            <textarea
              className="w-full rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm text-ink"
              rows={3}
              value={refundPolicy}
              onChange={(e) => setRefundPolicy(e.target.value)}
            />
          </label>
          <Button type="submit" loading={saveMutation.isPending}>
            Save store settings
          </Button>
          {message && <p className="text-sm text-state-success">{message}</p>}
          {error && (
            <p className="text-sm text-state-danger" role="alert">
              {error}
            </p>
          )}
        </form>
      </Card>

      <Card
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            Cooperative settings
            <StatusBadge label="Voting rights" tone="gold" />
            {isCoop ? (
              <span className="rounded-full bg-brand-gold/15 px-2 py-0.5 text-xs font-semibold text-brand-gold">
                COOP_ADMIN
              </span>
            ) : null}
          </span>
        }
      >
        <p className="mb-4 text-sm text-ink-muted">
          Network-wide ownership rules. Separated from store settings so capital and voting
          never look like store revenue controls. Investing more never buys more votes.
        </p>

        <div className="space-y-4">
          <div className="rounded-md border border-brand-gold/30 bg-brand-gold/10 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-gold">
              Voting threshold
            </p>
            <p className="mt-1 text-sm text-ink">
              Members gain voting rights when confirmed capital invested reaches{" "}
              <span className="font-semibold text-brand-gold">
                CooperativeSettings.votingThresholdAmount
              </span>{" "}
              (default $1,000). Above the threshold every voting member gets exactly one vote.
            </p>
            <p className="mt-2 text-xs text-ink-muted">
              Threshold is edited via cooperative settings on the server — not store PATCH.
            </p>
          </div>

          <div>
            <p className="text-sm font-semibold text-ink">Member discount bearer</p>
            <p className="mt-1 text-sm text-ink-muted">
              Who funds member perk discounts at this store (snapshotted onto each sale).
            </p>
            <p className="mt-2 font-semibold text-ink">
              {bearer}
              {bearer === "SHARED" && store.memberDiscountSharedPercent != null
                ? ` · operator share ${store.memberDiscountSharedPercent}%`
                : ""}
            </p>
          </div>

          <Field
            label="Operator percent"
            type="number"
            min={0}
            max={100}
            step="0.01"
            value={operatorPercent}
            onChange={(e) => setOperatorPercent(e.target.value)}
            disabled={!canEditPercent}
            required
            hint={
              canEditPercent
                ? "COOP_ADMIN only. Changing this does not recalculate past sales — each sale already snapshotted its operatorPercent. Operator % applies to PRE-TAX subtotal only."
                : "Only COOP_ADMIN can change the operator commission rate."
            }
          />

          {canEditPercent && (
            <Button
              type="button"
              loading={saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
            >
              Save cooperative controls
            </Button>
          )}
        </div>
      </Card>
    </div>
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
    return <p className="text-ink-muted">Select a store to edit settings.</p>;
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <PageHeader
        title="Settings"
        description="Store-local fields stay below; cooperative ownership controls are grouped separately and marked for COOP_ADMIN."
      />
      {storeQueryResult.isLoading && <p className="text-ink-muted">Loading…</p>}
      {storeQueryResult.data?.store && (
        <StoreSettingsForm
          key={storeQueryResult.data.store.id}
          store={storeQueryResult.data.store}
        />
      )}
    </div>
  );
}
