/**
 * Lots page — search by lot number, filter status/expiry, trace forward, quarantine.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "../api/client";
import type { Lot, LotStatus } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { formatExpiry, lotRowClass, lotStatusBadge } from "../lib/lotDisplay";

type TraceForward = {
  lotId: string;
  lotNumber: string;
  quantitySold: number;
  quantityRemaining: number;
  members: Array<{
    memberId: string;
    name: string;
    email: string;
    phone: string;
    quantityPurchased: number;
  }>;
  sales: Array<{ saleId: string; quantityFromLot: number }>;
};

const STATUSES: Array<LotStatus | ""> = [
  "",
  "ACTIVE",
  "QUARANTINED",
  "RECALLED",
  "EXPIRED",
  "DEPLETED",
];

export function LotsPage() {
  const { activeStoreId, isRole } = useAuth();
  const canQuarantine = isRole("STORE_ADMIN", "COOP_ADMIN");
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<LotStatus | "">("");
  const [expiryWithinDays, setExpiryWithinDays] = useState<string>("");
  const [traceLotId, setTraceLotId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (activeStoreId) p.set("storeId", activeStoreId);
    if (search.trim()) p.set("q", search.trim());
    if (status) p.set("status", status);
    if (expiryWithinDays) p.set("expiryWithinDays", expiryWithinDays);
    return p.toString();
  }, [activeStoreId, search, status, expiryWithinDays]);

  const lotsQuery = useQuery({
    queryKey: ["lots", params],
    enabled: !!activeStoreId,
    queryFn: () => apiRequest<{ lots: Lot[] }>(`/lots?${params}`),
  });

  const traceQuery = useQuery({
    queryKey: ["trace", "forward", traceLotId],
    enabled: !!traceLotId,
    queryFn: () => apiRequest<TraceForward>(`/traceability/lots/${traceLotId}/forward`),
  });

  const quarantine = useMutation({
    mutationFn: (lot: Lot) => {
      const reason = window.prompt(`Quarantine lot ${lot.lotNumber}. Reason:`, "");
      if (!reason?.trim()) throw new ApiError(400, "Reason required");
      return apiRequest<{ lot: Lot }>(`/lots/${lot.id}/quarantine`, {
        method: "POST",
        body: { reason: reason.trim(), ...(activeStoreId ? { storeId: activeStoreId } : {}) },
      });
    },
    onSuccess: () => {
      setMessage("Lot quarantined — it will not sell at POS");
      void qc.invalidateQueries({ queryKey: ["lots"] });
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["recalls", "active-for-store"] });
    },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : "Quarantine failed"),
  });

  if (!activeStoreId) {
    return <p className="text-stone-600">Select a store to browse lots.</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Lots</h1>
        <p className="mt-1 text-sm text-stone-600">
          Search by lot number or product. Trace opens the forward recall list. Quarantine pulls
          stock from sale immediately.
        </p>
      </div>

      {message && (
        <p className="rounded border border-stone-200 bg-white px-3 py-2 text-sm">{message}</p>
      )}

      <div className="flex flex-wrap gap-3 rounded-lg border border-stone-200 bg-white p-4">
        <label className="text-sm">
          Search
          <input
            className="mt-1 block min-w-[14rem] rounded border border-stone-300 px-3 py-2"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Lot #, SKU, name"
          />
        </label>
        <label className="text-sm">
          Status
          <select
            className="mt-1 block rounded border border-stone-300 px-3 py-2"
            value={status}
            onChange={(e) => setStatus(e.target.value as LotStatus | "")}
          >
            {STATUSES.map((s) => (
              <option key={s || "all"} value={s}>
                {s || "All"}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Expiry within
          <select
            className="mt-1 block rounded border border-stone-300 px-3 py-2"
            value={expiryWithinDays}
            onChange={(e) => setExpiryWithinDays(e.target.value)}
          >
            <option value="">Any</option>
            <option value="7">7 days</option>
            <option value="14">14 days</option>
            <option value="30">30 days</option>
            <option value="0">Overdue / today</option>
          </select>
        </label>
      </div>

      <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b bg-stone-50 text-stone-600">
            <tr>
              <th className="px-3 py-2">Lot #</th>
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Qty</th>
              <th className="px-3 py-2">Expiry</th>
              <th className="px-3 py-2">Supplier</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(lotsQuery.data?.lots ?? []).map((lot) => (
              <tr key={lot.id} className={`border-b border-stone-100 ${lotRowClass(lot)}`}>
                <td className="px-3 py-2 font-mono text-xs">{lot.lotNumber}</td>
                <td className="px-3 py-2">
                  <div>{lot.productName}</div>
                  <div className="font-mono text-xs text-stone-500">{lot.sku}</div>
                </td>
                <td className="px-3 py-2">{lot.quantityRemaining}</td>
                <td className="px-3 py-2">
                  {formatExpiry(lot.expiryDate, lot.daysUntilExpiry)}
                </td>
                <td className="px-3 py-2">{lot.supplier?.name ?? "—"}</td>
                <td className="px-3 py-2">
                  <span className={lotStatusBadge(lot.status)}>{lot.status}</span>
                </td>
                <td className="space-x-2 px-3 py-2 whitespace-nowrap">
                  <button
                    type="button"
                    className="underline"
                    onClick={() => setTraceLotId(lot.id)}
                  >
                    Trace
                  </button>
                  {canQuarantine && lot.status === "ACTIVE" && (
                    <button
                      type="button"
                      className="text-red-800 underline"
                      onClick={() => quarantine.mutate(lot)}
                    >
                      Quarantine
                    </button>
                  )}
                  {isRole("COOP_ADMIN") && (
                    <Link className="underline" to="/recalls">
                      Recall
                    </Link>
                  )}
                </td>
              </tr>
            ))}
            {!lotsQuery.isLoading && (lotsQuery.data?.lots ?? []).length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-stone-500">
                  No lots match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {traceLotId && (
        <section className="rounded-lg border border-stone-300 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-medium">Forward trace</h2>
            <button
              type="button"
              className="text-sm underline"
              onClick={() => setTraceLotId(null)}
            >
              Close
            </button>
          </div>
          {traceQuery.isLoading && <p className="mt-2 text-sm text-stone-500">Loading…</p>}
          {traceQuery.data && (
            <div className="mt-3 space-y-3 text-sm">
              <p>
                Lot <span className="font-mono">{traceQuery.data.lotNumber}</span> — sold{" "}
                {traceQuery.data.quantitySold}, remaining {traceQuery.data.quantityRemaining}
              </p>
              <div>
                <h3 className="font-medium">Affected members ({traceQuery.data.members.length})</h3>
                <ul className="mt-1 list-inside list-disc">
                  {traceQuery.data.members.map((m) => (
                    <li key={m.memberId}>
                      {m.name} · {m.email} · {m.quantityPurchased} unit(s)
                    </li>
                  ))}
                  {traceQuery.data.members.length === 0 && (
                    <li className="list-none text-stone-500">No member purchases yet.</li>
                  )}
                </ul>
              </div>
              <div>
                <h3 className="font-medium">Sales ({traceQuery.data.sales.length})</h3>
                <ul className="mt-1 list-inside list-disc font-mono text-xs">
                  {traceQuery.data.sales.map((s) => (
                    <li key={s.saleId}>
                      {s.saleId} ×{s.quantityFromLot}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {traceQuery.isError && (
            <p className="mt-2 text-sm text-red-700">
              {(traceQuery.error as Error).message}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
