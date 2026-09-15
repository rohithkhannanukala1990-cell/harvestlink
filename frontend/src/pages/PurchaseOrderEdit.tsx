/**
 * Create / edit / submit a purchase order.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest, money } from "../api/client";
import type { Product, PurchaseOrder, Supplier } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { storeQuery } from "../auth/storeQuery";

type DraftLine = { productId: string; orderedQty: string; unitCost: string };

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
      <div className="flex items-center gap-3">
        <Link to="/purchase-orders" className="text-sm underline">
          ← POs
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {isNew ? "New purchase order" : po?.poNumber ?? "Purchase order"}
        </h1>
        {po && <span className="rounded bg-stone-200 px-2 py-1 text-xs">{po.status}</span>}
      </div>
      {message && <p className="text-sm text-stone-600">{message}</p>}

      <form
        className="space-y-4 rounded-lg border border-stone-200 bg-white p-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (editable) saveMutation.mutate();
        }}
      >
        <label className="block text-sm">
          Supplier
          <select
            className="mt-1 w-full rounded border border-stone-300 px-3 py-2 disabled:bg-stone-100"
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
          </select>
        </label>

        {isRole("COOP_ADMIN") && isNew && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={coopLevel}
              onChange={(e) => setCoopLevel(e.target.checked)}
            />
            Co-op-level PO (not tied to one store)
          </label>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            Tax
            <input
              className="mt-1 w-full rounded border border-stone-300 px-3 py-2 disabled:bg-stone-100"
              value={tax}
              disabled={!editable}
              onChange={(e) => setTax(e.target.value)}
            />
          </label>
          <label className="text-sm">
            Shipping
            <input
              className="mt-1 w-full rounded border border-stone-300 px-3 py-2 disabled:bg-stone-100"
              value={shipping}
              disabled={!editable}
              onChange={(e) => setShipping(e.target.value)}
            />
          </label>
        </div>

        <div className="space-y-3">
          <h2 className="font-medium">Lines</h2>
          {lines.map((line, idx) => (
            <div key={idx} className="grid gap-2 sm:grid-cols-[1fr_100px_100px_auto]">
              <select
                className="rounded border border-stone-300 px-2 py-2 disabled:bg-stone-100"
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
                    .filter(
                      (p): p is NonNullable<typeof p> => Boolean(p),
                    ) ?? [])
                ).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.sku} — {p.name}
                  </option>
                ))}
              </select>
              <input
                className="rounded border border-stone-300 px-2 py-2"
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
                className="rounded border border-stone-300 px-2 py-2"
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
                <button
                  type="button"
                  className="rounded border border-stone-300 px-2"
                  onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          {editable && (
            <button
              type="button"
              className="text-sm underline"
              onClick={() =>
                setLines((prev) => [...prev, { productId: "", orderedQty: "1", unitCost: "" }])
              }
            >
              + Add line
            </button>
          )}
        </div>

        <p className="text-lg font-semibold">
          Subtotal {money(subtotal)} · Total{" "}
          {money(subtotal + (Number(tax) || 0) + (Number(shipping) || 0))}
        </p>

        <div className="flex flex-wrap gap-2">
          {editable && (
            <button type="submit" className="rounded bg-stone-900 px-4 py-2 text-white">
              {isNew ? "Create draft" : "Save draft"}
            </button>
          )}
          {!isNew && po?.status === "DRAFT" && (
            <button
              type="button"
              className="rounded bg-emerald-800 px-4 py-2 text-white"
              onClick={() => submitMutation.mutate()}
            >
              Submit PO
            </button>
          )}
          {!isNew && (po?.status === "SUBMITTED" || po?.status === "PARTIALLY_RECEIVED") && (
            <Link
              to={`/purchase-orders/${id}/receive`}
              className="rounded bg-emerald-800 px-4 py-2 text-white"
            >
              Receive goods
            </Link>
          )}
        </div>
      </form>

      {!isNew && po && (
        <section className="rounded-lg border border-stone-200 bg-white p-4 text-sm">
          <h2 className="mb-2 font-medium">Ordered vs received</h2>
          <ul className="space-y-1">
            {po.lines.map((l) => (
              <li key={l.id}>
                {l.product?.sku ?? l.productId}: {l.receivedQty}/{l.orderedQty}
                {l.shortClosed ? " (short-closed)" : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
