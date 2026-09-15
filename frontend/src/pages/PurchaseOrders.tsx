/**
 * Purchase order list with status filters + reorder suggestions entry.
 */
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiRequest, money } from "../api/client";
import type { PurchaseOrder, PurchaseOrderStatus, ReorderSuggestion } from "../api/types";
import { useAuth } from "../auth/AuthContext";

const STATUSES: Array<PurchaseOrderStatus | "ALL"> = [
  "ALL",
  "DRAFT",
  "SUBMITTED",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "CANCELLED",
];

export function PurchaseOrdersPage() {
  const { activeStoreId } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState<PurchaseOrderStatus | "ALL">("ALL");
  const [message, setMessage] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["purchase-orders", activeStoreId, status],
    queryFn: () => {
      const params = new URLSearchParams();
      if (status !== "ALL") params.set("status", status);
      if (activeStoreId) params.set("storeId", activeStoreId);
      const qs = params.toString();
      return apiRequest<{ purchaseOrders: PurchaseOrder[] }>(
        `/purchasing/purchase-orders${qs ? `?${qs}` : ""}`,
      );
    },
  });

  const suggestionsQuery = useQuery({
    queryKey: ["reorder-suggestions", activeStoreId],
    enabled: !!activeStoreId,
    queryFn: () =>
      apiRequest<{ suggestions: ReorderSuggestion[] }>(
        `/purchasing/reorder-suggestions?storeId=${activeStoreId}`,
      ),
  });

  const createFromSuggestion = useMutation({
    mutationFn: (s: ReorderSuggestion) =>
      apiRequest<{ purchaseOrder: PurchaseOrder }>("/purchasing/purchase-orders", {
        method: "POST",
        body: {
          supplierId: s.supplierId,
          storeId: activeStoreId,
          lines: s.lines.map((l) => ({
            productId: l.productId,
            orderedQty: l.suggestedQty,
            unitCost: Number(l.unitCost),
          })),
        },
      }),
    onSuccess: (data) => {
      setMessage(`Draft ${data.purchaseOrder.poNumber} created from reorder suggestion`);
      void qc.invalidateQueries({ queryKey: ["purchase-orders"] });
    },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : "Create failed"),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Purchase orders</h1>
        <Link
          to="/purchase-orders/new"
          className="rounded bg-stone-900 px-4 py-2 text-sm text-white"
        >
          New PO
        </Link>
      </div>
      {message && <p className="text-sm text-stone-600">{message}</p>}

      <div className="flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={`rounded px-3 py-1 text-sm ${
              status === s ? "bg-stone-900 text-white" : "bg-white border border-stone-300"
            }`}
          >
            {s === "PARTIALLY_RECEIVED" ? "PARTIAL" : s}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b bg-stone-50 text-stone-600">
            <tr>
              <th className="px-3 py-2">PO #</th>
              <th className="px-3 py-2">Supplier</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Total</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {(listQuery.data?.purchaseOrders ?? []).map((po) => (
              <tr key={po.id}>
                <td className="px-3 py-2 font-mono text-xs">{po.poNumber}</td>
                <td className="px-3 py-2">{po.supplier?.name ?? po.supplierId}</td>
                <td className="px-3 py-2">{po.status}</td>
                <td className="px-3 py-2">{money(po.total)}</td>
                <td className="px-3 py-2 space-x-2">
                  <Link className="underline" to={`/purchase-orders/${po.id}`}>
                    Open
                  </Link>
                  {(po.status === "SUBMITTED" || po.status === "PARTIALLY_RECEIVED") && (
                    <Link className="font-medium text-emerald-800 underline" to={`/purchase-orders/${po.id}/receive`}>
                      Receive
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {activeStoreId && (
        <section className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="font-medium">Low-stock reorder suggestions</h2>
          {(suggestionsQuery.data?.suggestions ?? []).length === 0 ? (
            <p className="text-sm text-stone-600">No products at/below reorder point with a preferred supplier.</p>
          ) : (
            (suggestionsQuery.data?.suggestions ?? []).map((s) => (
              <div key={s.supplierId} className="rounded border border-amber-200 bg-white p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">{s.supplierName}</div>
                    <div className="text-sm text-stone-600">
                      {s.lines.length} SKUs · {money(s.suggestedSubtotal)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="rounded bg-stone-900 px-3 py-2 text-sm text-white"
                    onClick={() => createFromSuggestion.mutate(s)}
                  >
                    Create draft PO
                  </button>
                </div>
                <ul className="text-xs text-stone-600">
                  {s.lines.map((l) => (
                    <li key={l.productId}>
                      {l.sku} avail {l.available}/{l.reorderAt} → order {l.suggestedQty}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
      )}
    </div>
  );
}
