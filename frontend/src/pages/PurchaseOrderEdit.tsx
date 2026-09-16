/**
 * Create / edit / submit a purchase order.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "../api/client";
import type { Product, PurchaseOrder, Supplier } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { storeQuery } from "../auth/storeQuery";
import {
  Button,
  Card,
  Field,
  Money,
  PageHeader,
  SelectField,
  StatusBadge,
} from "../components/ui";

type DraftLine = { productId: string; orderedQty: string; unitCost: string };

function poStatusLabel(status: PurchaseOrder["status"]) {
  if (status === "RECEIVED") return <StatusBadge label="Delivered" tone="success" />;
  if (status === "SUBMITTED") return <StatusBadge label="Confirmed" tone="success" />;
  if (status === "CANCELLED") return <StatusBadge label="Cancelled" tone="neutral" />;
  if (status === "PARTIALLY_RECEIVED" || status === "DRAFT") {
    return <StatusBadge label="Pending" tone="warning" />;
  }
  return <StatusBadge label={status} tone="neutral" />;
}

export function PurchaseOrderEditPage() {
  const { id } = useParams();
  const isNew = !id || id === "new";
  const navigate = useNavigate();
  const { activeStoreId, isRole } = useAuth();
  const qc = useQueryClient();
  const q = storeQuery(activeStoreId);
  const [supplierId, setSupplierId] = useState("");
  const [tax, setTax] = useState("0");
  const [shipping, setShipping] = useState("0");
  const [coopLevel, setCoopLevel] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([
    { productId: "", orderedQty: "1", unitCost: "" },
  ]);
  const [message, setMessage] = useState<string | null>(null);

  const suppliersQuery = useQuery({
    queryKey: ["suppliers", "active"],
    queryFn: () =>
      apiRequest<{ suppliers: Supplier[] }>("/purchasing/suppliers?active=true"),
  });

  const productsQuery = useQuery({
    queryKey: ["products", activeStoreId],
    enabled: !!activeStoreId && !coopLevel,
    queryFn: () => apiRequest<{ products: Product[] }>(`/products${q ? `?${q}` : ""}`),
  });

  const poQuery = useQuery({
    queryKey: ["purchase-order", id],
    enabled: !isNew && !!id,
    queryFn: async () => {
      const data = await apiRequest<{ purchaseOrder: PurchaseOrder }>(
        `/purchasing/purchase-orders/${id}`,
      );
      const po = data.purchaseOrder;
      setSupplierId(po.supplierId);
      setTax(String(po.tax));
      setShipping(String(po.shipping));
      setCoopLevel(po.storeId === null);
      setLines(
        po.lines.map((l) => ({
          productId: l.productId,
          orderedQty: String(l.orderedQty),
          unitCost: String(l.unitCost),
        })),
      );
      return data;
    },
  });

  const po = poQuery.data?.purchaseOrder;
  const editable = isNew || po?.status === "DRAFT";

  const subtotal = useMemo(
    () =>
      lines.reduce((sum, l) => {
        const qty = Number(l.orderedQty) || 0;
        const cost = Number(l.unitCost) || 0;
        return sum + qty * cost;
      }, 0),
    [lines],
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = {
        supplierId,
        storeId: coopLevel ? null : activeStoreId,
        tax: Number(tax) || 0,
        shipping: Number(shipping) || 0,
        lines: lines
          .filter((l) => l.productId)
          .map((l) => ({
            productId: l.productId,
            orderedQty: Number(l.orderedQty),
            unitCost: Number(l.unitCost),
          })),
      };
      if (isNew) {
        return apiRequest<{ purchaseOrder: PurchaseOrder }>("/purchasing/purchase-orders", {
          method: "POST",
          body,
        });
      }
      return apiRequest<{ purchaseOrder: PurchaseOrder }>(`/purchasing/purchase-orders/${id}`, {
        method: "PATCH",
        body: {
          tax: body.tax,
          shipping: body.shipping,
          lines: body.lines,
        },
      });
    },
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      if (isNew) navigate(`/purchase-orders/${data.purchaseOrder.id}`, { replace: true });
      else {
        setMessage("PO saved");
        void qc.invalidateQueries({ queryKey: ["purchase-order", id] });
      }
    },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : "Save failed"),
  });

  const submitMutation = useMutation({
    mutationFn: () =>
      apiRequest<{ purchaseOrder: PurchaseOrder }>(`/purchasing/purchase-orders/${id}/submit`, {
        method: "POST",
        body: {},
      }),
    onSuccess: () => {
      setMessage("PO submitted");
      void qc.invalidateQueries({ queryKey: ["purchase-order", id] });
      void qc.invalidateQueries({ queryKey: ["purchase-orders"] });
    },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : "Submit failed"),
  });

  useEffect(() => {
    if (coopLevel && !isRole("COOP_ADMIN")) setCoopLevel(false);
  }, [coopLevel, isRole]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={isNew ? "New purchase order" : (po?.poNumber ?? "Purchase order")}
        description={
          <Link to="/purchase-orders" className="text-brand-terracotta-ink underline">
            ← POs
          </Link>
        }
        actions={po ? poStatusLabel(po.status) : undefined}
      />
      {message && <p className="text-sm text-ink-muted">{message}</p>}

      <Card>
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (editable) saveMutation.mutate();
          }}
        >
          <SelectField
            label="Supplier"
            value={supplierId}
            disabled={!editable || !isNew}
            onChange={(e) => setSupplierId(e.target.value)}
            required
          >
            <option value="">Select…</option>
            {(suppliersQuery.data?.suppliers ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectField>

          {isRole("COOP_ADMIN") && isNew && (
            <label className="flex items-center gap-2 rounded-md border border-brand-gold/30 bg-brand-gold/10 p-3 text-sm text-ink">
              <input
                type="checkbox"
                checked={coopLevel}
                onChange={(e) => setCoopLevel(e.target.checked)}
              />
              <span>
                <span className="font-semibold text-brand-gold">COOP_ADMIN only · </span>
                Co-op-level PO (not tied to one store)
              </span>
            </label>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Tax"
              value={tax}
              disabled={!editable}
              onChange={(e) => setTax(e.target.value)}
            />
            <Field
              label="Shipping"
              value={shipping}
              disabled={!editable}
              onChange={(e) => setShipping(e.target.value)}
            />
          </div>

          <div className="space-y-3">
            <h2 className="font-semibold text-ink">Lines</h2>
            {lines.map((line, idx) => (
              <div key={idx} className="grid gap-2 sm:grid-cols-[1fr_100px_100px_auto]">
                <select
                  className="min-h-[44px] rounded-md border border-border-strong bg-surface-raised px-2 py-2 text-sm text-ink disabled:bg-surface-sunken"
                  value={line.productId}
                  disabled={!editable}
                  onChange={(e) => {
                    const productId = e.target.value;
                    const product = productsQuery.data?.products.find((p) => p.id === productId);
                    setLines((prev) =>
                      prev.map((l, i) =>
                        i === idx
                          ? {
                              ...l,
                              productId,
                              unitCost: product ? String(product.cost) : l.unitCost,
                            }
                          : l,
                      ),
                    );
                  }}
                >
                  <option value="">Product…</option>
                  {(
                    productsQuery.data?.products ??
                    (po?.lines
                      .map((l) => l.product)
                      .filter((p): p is NonNullable<typeof p> => Boolean(p)) ?? [])
                  ).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.sku} — {p.name}
                    </option>
                  ))}
                </select>
                <input
                  className="tabular min-h-[44px] rounded-md border border-border-strong px-2 py-2 text-sm"
                  placeholder="Qty"
                  disabled={!editable}
                  value={line.orderedQty}
                  onChange={(e) =>
                    setLines((prev) =>
                      prev.map((l, i) => (i === idx ? { ...l, orderedQty: e.target.value } : l)),
                    )
                  }
                />
                <input
                  className="tabular min-h-[44px] rounded-md border border-border-strong px-2 py-2 text-sm"
                  placeholder="Unit $"
                  disabled={!editable}
                  value={line.unitCost}
                  onChange={(e) =>
                    setLines((prev) =>
                      prev.map((l, i) => (i === idx ? { ...l, unitCost: e.target.value } : l)),
                    )
                  }
                />
                {editable && (
                  <Button
                    type="button"
                    variant="quiet"
                    onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    Remove
                  </Button>
                )}
              </div>
            ))}
            {editable && (
              <Button
                type="button"
                variant="quiet"
                onClick={() =>
                  setLines((prev) => [...prev, { productId: "", orderedQty: "1", unitCost: "" }])
                }
              >
                Add line
              </Button>
            )}
          </div>

          <p className="text-lg font-bold text-ink">
            Subtotal <Money value={subtotal} /> · Total{" "}
            <Money value={subtotal + (Number(tax) || 0) + (Number(shipping) || 0)} />
          </p>

          <div className="flex flex-wrap gap-2">
            {editable && (
              <Button type="submit" loading={saveMutation.isPending}>
                {isNew ? "Create draft" : "Save draft"}
              </Button>
            )}
            {!isNew && po?.status === "DRAFT" && (
              <Button
                type="button"
                loading={submitMutation.isPending}
                onClick={() => submitMutation.mutate()}
              >
                Submit PO
              </Button>
            )}
            {!isNew && (po?.status === "SUBMITTED" || po?.status === "PARTIALLY_RECEIVED") && (
              <Link
                to={`/purchase-orders/${id}/receive`}
                className="inline-flex min-h-[44px] items-center rounded-md bg-brand-green px-4 text-sm font-semibold text-ink-inverse"
              >
                Receive goods
              </Link>
            )}
          </div>
        </form>
      </Card>

      {!isNew && po && (
        <Card title="Ordered vs received">
          <ul className="space-y-1 text-sm text-ink">
            {po.lines.map((l) => (
              <li key={l.id}>
                {l.product?.sku ?? l.productId}:{" "}
                <span className="tabular">
                  {l.receivedQty}/{l.orderedQty}
                </span>
                {l.shortClosed ? " (short-closed)" : ""}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
