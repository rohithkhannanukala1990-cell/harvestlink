/**
 * Sales history with receipt reprint / email and sale detail (lots visible here, not on POS).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, apiRequest, getToken } from "../api/client";
import type { Sale } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { storeQuery } from "../auth/storeQuery";
import {
  Button,
  Card,
  DataTable,
  LotStatusBadge,
  Money,
  PageHeader,
  StatusBadge,
  type DataTableColumn,
} from "../components/ui";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

function paymentStatusBadge(status: Sale["paymentStatus"]) {
  if (status === "PAID") return <StatusBadge label="Paid" tone="success" />;
  if (status === "PENDING" || status === "REFUNDING") {
    return <StatusBadge label="Pending" tone="warning" />;
  }
  if (status === "FAILED") return <StatusBadge label="Failed" tone="danger" />;
  if (status === "REFUNDED") return <StatusBadge label="Closed" tone="neutral" />;
  return <StatusBadge label="Expired" tone="neutral" />;
}

export function SalesHistoryPage() {
  const { activeStoreId } = useAuth();
  const q = storeQuery(activeStoreId);
  const [message, setMessage] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const salesQuery = useQuery({
    queryKey: ["sales", "history", activeStoreId],
    enabled: !!activeStoreId,
    queryFn: () =>
      apiRequest<{ sales: Sale[]; total: number }>(
        `/sales?page=1&pageSize=50${q ? `&${q}` : ""}`,
      ),
  });

  const detailQuery = useQuery({
    queryKey: ["sales", detailId, activeStoreId],
    enabled: !!detailId && !!activeStoreId,
    queryFn: () =>
      apiRequest<{ sale: Sale }>(`/sales/${detailId}${q ? `?${q}` : ""}`),
  });

  function openReceipt(saleId: string) {
    const token = getToken();
    const url = `${API_BASE}/sales/${saleId}/receipt${q ? `?${q}` : ""}`;
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
    return <p className="text-ink-muted">Select a store to view sales.</p>;
  }

  const detail = detailQuery.data?.sale;
  const sales = salesQuery.data?.sales ?? [];

  const columns: DataTableColumn<Sale>[] = [
    {
      id: "when",
      header: "When",
      cell: (sale) => (
        <span className="whitespace-nowrap">
          {new Date(sale.paidAt ?? sale.createdAt).toLocaleString()}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (sale) => paymentStatusBadge(sale.paymentStatus),
    },
    {
      id: "pay",
      header: "Pay",
      cell: (sale) => sale.paymentMethod ?? "—",
    },
    {
      id: "total",
      header: "Total",
      numeric: true,
      cell: (sale) => <Money value={sale.total} />,
    },
    {
      id: "tax",
      header: "Tax",
      numeric: true,
      cell: (sale) => <Money value={sale.taxAmount ?? 0} />,
    },
    {
      id: "actions",
      header: "Actions",
      cell: (sale) => (
        <span className="inline-flex flex-wrap gap-2">
          <Button
            type="button"
            variant="quiet"
            onClick={() => setDetailId(detailId === sale.id ? null : sale.id)}
          >
            {detailId === sale.id ? "Hide" : "Detail"}
          </Button>
          {(sale.paymentStatus === "PAID" || sale.paymentStatus === "REFUNDED") && (
            <>
              <Button type="button" variant="quiet" onClick={() => openReceipt(sale.id)}>
                Reprint
              </Button>
              <Button
                type="button"
                variant="quiet"
                onClick={() => void emailReceipt(sale.id)}
              >
                Email
              </Button>
            </>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Sales history" />
      {message && <p className="text-sm text-ink-muted">{message}</p>}
      <DataTable
        columns={columns}
        rows={sales}
        rowKey={(sale) => sale.id}
        emptyMessage="No sales yet"
      />

      {detailId && (
        <Card title="Sale detail">
          {detailQuery.isLoading && <p className="text-sm text-ink-muted">Loading…</p>}
          {detail && (
            <ul className="space-y-3 text-sm">
              {detail.items.map((item) => (
                <li key={item.id} className="border-b border-border-hairline pb-2">
                  <div className="font-semibold text-ink">
                    {item.nameSnapshot}{" "}
                    <span className="font-normal text-ink-muted">
                      ×<span className="tabular">{item.quantity}</span> @{" "}
                      <Money value={item.priceSnapshot} />
                    </span>
                  </div>
                  <div className="mt-1 text-ink-muted">
                    {item.lotAllocations && item.lotAllocations.length > 0 ? (
                      item.lotAllocations.map((a) => (
                        <div
                          key={a.id}
                          className="flex flex-wrap items-center gap-2 font-mono text-xs"
                        >
                          <span>
                            Lot {a.lot?.lotNumber ?? a.lotId}
                            {a.quantity !== item.quantity ? (
                              <>
                                {" "}
                                ×<span className="tabular">{a.quantity}</span>
                              </>
                            ) : null}
                          </span>
                          {a.lot?.status ? (
                            <LotStatusBadge status={a.lot.status} />
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <span className="text-xs text-ink-muted">No lot allocation recorded</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
