/**
 * Purchase order list with status filters + reorder suggestions entry.
 */
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiRequest } from "../api/client";
import type { PurchaseOrder, PurchaseOrderStatus, ReorderSuggestion } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import {
  Button,
  Card,
  DataTable,
  Money,
  PageHeader,
  StatusBadge,
  type DataTableColumn,
  type StatusTone,
} from "../components/ui";

const STATUSES: Array<PurchaseOrderStatus | "ALL"> = [
  "ALL",
  "DRAFT",
  "SUBMITTED",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "CANCELLED",
];

function poStatusBadge(status: PurchaseOrderStatus) {
  const map: Record<PurchaseOrderStatus, { label: string; tone: StatusTone }> = {
    DRAFT: { label: "Pending", tone: "warning" },
    SUBMITTED: { label: "Confirmed", tone: "success" },
    PARTIALLY_RECEIVED: { label: "Pending", tone: "warning" },
    RECEIVED: { label: "Delivered", tone: "success" },
    CANCELLED: { label: "Cancelled", tone: "neutral" },
  };
  const entry = map[status];
  return <StatusBadge label={entry.label} tone={entry.tone} />;
}

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

  const orders = listQuery.data?.purchaseOrders ?? [];

  const columns: DataTableColumn<PurchaseOrder>[] = [
    {
      id: "po",
      header: "PO #",
      cell: (po) => <span className="font-mono text-xs">{po.poNumber}</span>,
    },
    {
      id: "supplier",
      header: "Supplier",
      cell: (po) => po.supplier?.name ?? po.supplierId,
    },
    {
      id: "status",
      header: "Status",
      cell: (po) => poStatusBadge(po.status),
    },
    {
      id: "total",
      header: "Total",
      numeric: true,
      cell: (po) => <Money value={po.total} />,
    },
    {
      id: "actions",
      header: "Actions",
      cell: (po) => (
        <span className="inline-flex flex-wrap gap-2">
          <Link
            className="inline-flex min-h-[44px] items-center rounded-md border border-border-strong bg-surface-raised px-3 text-sm font-semibold text-ink"
            to={`/purchase-orders/${po.id}`}
          >
            Open
          </Link>
          {(po.status === "SUBMITTED" || po.status === "PARTIALLY_RECEIVED") && (
            <Link
              className="inline-flex min-h-[44px] items-center rounded-md bg-brand-green px-3 text-sm font-semibold text-ink-inverse"
              to={`/purchase-orders/${po.id}/receive`}
            >
              Receive
            </Link>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Purchase orders"
        actions={
          <Link
            to="/purchase-orders/new"
            className="inline-flex min-h-[44px] items-center rounded-md bg-brand-green px-4 text-sm font-semibold text-ink-inverse"
          >
            New PO
          </Link>
        }
      />
      {message && <p className="text-sm text-ink-muted">{message}</p>}

      <div className="flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={`min-h-[44px] rounded-md px-3 py-2 text-sm font-semibold ${
              status === s
                ? "bg-surface-canopy text-ink-inverse"
                : "border border-border-strong bg-surface-raised text-ink"
            }`}
          >
            {s === "PARTIALLY_RECEIVED" ? "PARTIAL" : s}
          </button>
        ))}
      </div>

      <DataTable
        columns={columns}
        rows={orders}
        rowKey={(po) => po.id}
        emptyMessage="No purchase orders"
      />

      {activeStoreId && (
        <Card
          title={
            <span className="inline-flex items-center gap-2">
              Low-stock reorder suggestions
              <StatusBadge label="Low stock" tone="warning" />
            </span>
          }
        >
          {(suggestionsQuery.data?.suggestions ?? []).length === 0 ? (
            <p className="text-sm text-ink-muted">
              No products at/below reorder point with a preferred supplier.
            </p>
          ) : (
            <div className="space-y-3">
              {(suggestionsQuery.data?.suggestions ?? []).map((s) => (
                <div
                  key={s.supplierId}
                  className="rounded-md border border-border-hairline bg-surface-sunken p-3"
                >
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="font-semibold text-ink">{s.supplierName}</div>
                      <div className="text-sm text-ink-muted">
                        <span className="tabular">{s.lines.length}</span> SKUs ·{" "}
                        <Money value={s.suggestedSubtotal} />
                      </div>
                    </div>
                    <Button
                      type="button"
                      loading={createFromSuggestion.isPending}
                      onClick={() => createFromSuggestion.mutate(s)}
                    >
                      Create draft PO
                    </Button>
                  </div>
                  <ul className="text-xs text-ink-muted">
                    {s.lines.map((l) => (
                      <li key={l.productId}>
                        {l.sku} avail{" "}
                        <span className="tabular">
                          {l.available}/{l.reorderAt}
                        </span>{" "}
                        → order <span className="tabular">{l.suggestedQty}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
