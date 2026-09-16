/**
 * Recall management — COOP_ADMIN initiates / activates / closes product recalls.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiRequest } from "../api/client.ts";

type RecallRow = {
  id: string;
  recallNumber: string;
  reason: string;
  severity: string;
  status: string;
  initiatedAt: string;
  lots: Array<{ id: string; lotId: string; quantityAtRecall: number; lot: { lotNumber: string } }>;
  _count: { notifications: number };
};

type Impact = {
  affectedMembers: Array<{ memberId: string; name: string; email: string; quantityPurchased: number }>;
  unitsSold: number;
  unitsOnShelves: number;
  storesInvolved: Array<{ storeName: string }>;
  estimatedFinancialExposure: string;
};

export function RecallsPage() {
  const qc = useQueryClient();
  const [lotIdsText, setLotIdsText] = useState("");
  const [reason, setReason] = useState("");
  const [severity, setSeverity] = useState<"ADVISORY" | "VOLUNTARY" | "MANDATORY">("VOLUNTARY");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["recalls"],
    queryFn: () => apiRequest<{ recalls: RecallRow[] }>("/recalls"),
  });

  const impactQuery = useQuery({
    queryKey: ["recalls", selectedId, "impact"],
    queryFn: () => apiRequest<Impact>(`/recalls/${selectedId}/impact`),
    enabled: !!selectedId,
  });

  const initiate = useMutation({
    mutationFn: () =>
      apiRequest<{ recall: RecallRow }>("/recalls", {
        method: "POST",
        body: {
          lotIds: lotIdsText
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter(Boolean),
          reason,
          severity,
        },
      }),
    onSuccess: () => {
      setError(null);
      setLotIdsText("");
      setReason("");
      void qc.invalidateQueries({ queryKey: ["recalls"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const activate = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/recalls/${id}/activate`, { method: "POST", body: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["recalls"] });
      void qc.invalidateQueries({ queryKey: ["recalls", "active-for-store"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const dispatch = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/recalls/${id}/dispatch`, { method: "POST", body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["recalls"] }),
    onError: (e: Error) => setError(e.message),
  });

  const refunds = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/recalls/${id}/refunds`, { method: "POST", body: {} }),
    onError: (e: Error) => setError(e.message),
  });

  const close = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/recalls/${id}/close`, { method: "POST", body: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["recalls"] });
      void qc.invalidateQueries({ queryKey: ["recalls", "active-for-store"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const recalls = listQuery.data?.recalls ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Recalls</h1>
        <p className="mt-1 text-sm text-stone-600">
          Quarantine first, investigate second. Recalled goods never return to sellable stock.
          Records are retained for regulators — never deleted.
        </p>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}

      <section className="rounded-lg border border-stone-200 bg-white p-4">
        <h2 className="text-lg font-medium">Initiate recall</h2>
        <p className="mt-1 text-sm text-stone-500">
          Lots are quarantined immediately so POS cannot sell another unit during setup.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm sm:col-span-2">
            <span className="font-medium">Lot IDs</span>
            <textarea
              className="mt-1 w-full rounded border border-stone-300 px-3 py-2"
              rows={2}
              value={lotIdsText}
              onChange={(e) => setLotIdsText(e.target.value)}
              placeholder="cuid lot ids, comma or space separated"
            />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="font-medium">Reason</span>
            <input
              className="mt-1 w-full rounded border border-stone-300 px-3 py-2"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Severity</span>
            <select
              className="mt-1 w-full rounded border border-stone-300 px-3 py-2"
              value={severity}
              onChange={(e) => setSeverity(e.target.value as typeof severity)}
            >
              <option value="ADVISORY">ADVISORY</option>
              <option value="VOLUNTARY">VOLUNTARY</option>
              <option value="MANDATORY">MANDATORY</option>
            </select>
          </label>
        </div>
        <button
          type="button"
          className="mt-4 rounded bg-red-800 px-4 py-2 text-sm font-medium text-white hover:bg-red-900 disabled:opacity-50"
          disabled={initiate.isPending || !lotIdsText.trim() || !reason.trim()}
          onClick={() => initiate.mutate()}
        >
          Quarantine &amp; create DRAFT
        </button>
      </section>

      <section className="rounded-lg border border-stone-200 bg-white p-4">
        <h2 className="text-lg font-medium">Open recalls</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-stone-200 text-stone-500">
              <tr>
                <th className="py-2 pr-4">Number</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Severity</th>
                <th className="py-2 pr-4">Lots</th>
                <th className="py-2 pr-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {recalls.map((r) => (
                <tr key={r.id} className="border-b border-stone-100">
                  <td className="py-2 pr-4 font-medium">{r.recallNumber}</td>
                  <td className="py-2 pr-4">{r.status}</td>
                  <td className="py-2 pr-4">{r.severity}</td>
                  <td className="py-2 pr-4">
                    {r.lots.map((l) => l.lot.lotNumber).join(", ")}
                  </td>
                  <td className="py-2 pr-4">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50"
                        onClick={() => setSelectedId(r.id)}
                      >
                        Impact
                      </button>
                      {r.status === "DRAFT" && (
                        <button
                          type="button"
                          className="rounded border border-red-300 px-2 py-1 text-xs text-red-800 hover:bg-red-50"
                          onClick={() => activate.mutate(r.id)}
                        >
                          Activate
                        </button>
                      )}
                      {r.status === "ACTIVE" && (
                        <>
                          <button
                            type="button"
                            className="rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50"
                            onClick={() => dispatch.mutate(r.id)}
                          >
                            Dispatch notices
                          </button>
                          <button
                            type="button"
                            className="rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50"
                            onClick={() => refunds.mutate(r.id)}
                          >
                            Refund (no restock)
                          </button>
                          <button
                            type="button"
                            className="rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50"
                            onClick={() => close.mutate(r.id)}
                          >
                            Close
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {recalls.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-stone-500">
                    No recalls yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selectedId && impactQuery.data && (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-lg font-medium">Impact preview</h2>
          <p className="mt-1 text-sm text-stone-700">
            Sold {impactQuery.data.unitsSold} · On shelves {impactQuery.data.unitsOnShelves} ·
            Exposure ${impactQuery.data.estimatedFinancialExposure} · Stores{" "}
            {impactQuery.data.storesInvolved.map((s) => s.storeName).join(", ") || "—"}
          </p>
          <ul className="mt-3 list-inside list-disc text-sm">
            {impactQuery.data.affectedMembers.map((m) => (
              <li key={m.memberId}>
                {m.name} ({m.email}) — {m.quantityPurchased} unit(s)
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
