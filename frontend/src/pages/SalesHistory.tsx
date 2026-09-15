/**
 * Sales history with receipt reprint / email.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, apiRequest, getToken, money } from "../api/client";
import type { Sale } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { storeQuery } from "../auth/storeQuery";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

export function SalesHistoryPage() {
  const { activeStoreId } = useAuth();
  const q = storeQuery(activeStoreId);
  const [message, setMessage] = useState<string | null>(null);

  const salesQuery = useQuery({
    queryKey: ["sales", "history", activeStoreId],
    enabled: !!activeStoreId,
    queryFn: () =>
      apiRequest<{ sales: Sale[]; total: number }>(
        `/sales?page=1&pageSize=50${q ? `&${q}` : ""}`,
      ),
  });

  function openReceipt(saleId: string) {
    const token = getToken();
    const url = `${API_BASE}/sales/${saleId}/receipt${q ? `?${q}` : ""}`;
    // Receipt is HTML with Bearer auth — open via fetch blob for reprint.
    void fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        const html = await res.text();
        const w = window.open("", "_blank");
        if (w) {
          w.document.write(html);
          w.document.close();
        }
      })
      .catch((err) => setMessage(err instanceof Error ? err.message : "Receipt failed"));
  }

  async function emailReceipt(saleId: string) {
    try {
      const result = await apiRequest<{ sent: boolean; to: string; mode: string }>(
        `/sales/${saleId}/receipt/email`,
        { method: "POST", body: activeStoreId ? { storeId: activeStoreId } : {} },
      );
      setMessage(
        result.mode === "smtp"
          ? `Receipt emailed to ${result.to}`
          : `SMTP not configured — receipt logged for ${result.to}`,
      );
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Email failed");
    }
  }

  if (!activeStoreId) {
    return <p className="text-stone-600">Select a store to view sales.</p>;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Sales history</h1>
      {message && <p className="text-sm text-stone-600">{message}</p>}
      <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b bg-stone-50 text-stone-600">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Pay</th>
              <th className="px-3 py-2">Total</th>
              <th className="px-3 py-2">Tax</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {(salesQuery.data?.sales ?? []).map((sale) => (
              <tr key={sale.id}>
                <td className="px-3 py-2 whitespace-nowrap">
                  {new Date(sale.paidAt ?? sale.createdAt).toLocaleString()}
                </td>
                <td className="px-3 py-2">{sale.paymentStatus}</td>
                <td className="px-3 py-2">{sale.paymentMethod ?? "—"}</td>
                <td className="px-3 py-2">{money(sale.total)}</td>
                <td className="px-3 py-2">{money(sale.taxAmount ?? 0)}</td>
                <td className="px-3 py-2 space-x-2">
                  {(sale.paymentStatus === "PAID" || sale.paymentStatus === "REFUNDED") && (
                    <>
                      <button
                        type="button"
                        className="underline"
                        onClick={() => openReceipt(sale.id)}
                      >
                        Reprint
                      </button>
                      <button
                        type="button"
                        className="underline"
                        onClick={() => void emailReceipt(sale.id)}
                      >
                        Email
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
