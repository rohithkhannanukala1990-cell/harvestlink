/**
 * Inventory management page.
 *
 * Expand a product to see lots — lot number, qty, expiry, supplier, status.
 * Near-expiry and quarantined/recalled lots are colour-coded.
 */
import { Fragment, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest, money } from "../api/client";
import type { Lot, Product } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { storeQuery } from "../auth/storeQuery";
import { formatExpiry, lotRowClass, lotStatusBadge } from "../lib/lotDisplay";

const emptyForm = {
  sku: "",
  name: "",
  category: "",
  price: "",
  cost: "",
  stock: "0",
  reorderAt: "5",
  taxExempt: false,
};

function ProductLots({ productId }: { productId: string }) {
  const { activeStoreId } = useAuth();
  const q = storeQuery(activeStoreId);
  const lotsQuery = useQuery({
    queryKey: ["products", productId, "lots", activeStoreId],
    enabled: !!activeStoreId,
    queryFn: () =>
      apiRequest<{ lots: Lot[] }>(`/products/${productId}/lots${q ? `?${q}` : ""}`),
  });

  if (lotsQuery.isLoading) {
    return <p className="px-3 py-2 text-sm text-stone-500">Loading lots…</p>;
  }
  const lots = lotsQuery.data?.lots ?? [];
  if (!lots.length) {
    return <p className="px-3 py-2 text-sm text-stone-500">No lots for this product.</p>;
  }

  return (
    <table className="min-w-full text-left text-xs">
      <thead className="text-stone-500">
        <tr>
          <th className="px-3 py-1">Lot #</th>
          <th className="px-3 py-1">Qty</th>
          <th className="px-3 py-1">Expiry</th>
          <th className="px-3 py-1">Supplier</th>
          <th className="px-3 py-1">Status</th>
        </tr>
      </thead>
      <tbody>
        {lots.map((lot) => (
          <tr key={lot.id} className={`border-t border-stone-100 ${lotRowClass(lot)}`}>
            <td className="px-3 py-1.5 font-mono">{lot.lotNumber}</td>
            <td className="px-3 py-1.5">
              {lot.quantityRemaining}
              {lot.quantityReserved > 0 ? (
                <span className="ml-1 text-stone-500">({lot.quantityReserved} held)</span>
              ) : null}
            </td>
            <td className="px-3 py-1.5">
              {formatExpiry(lot.expiryDate, lot.daysUntilExpiry)}
            </td>
            <td className="px-3 py-1.5">{lot.supplier?.name ?? "—"}</td>
            <td className="px-3 py-1.5">
              <span className={lotStatusBadge(lot.status)}>{lot.status}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function InventoryPage() {
  const { activeStoreId, isRole } = useAuth();
  const canEdit = isRole("STORE_ADMIN", "COOP_ADMIN");
  const qc = useQueryClient();
  const q = storeQuery(activeStoreId);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<Product | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const productsQuery = useQuery({
    queryKey: ["products", activeStoreId],
    enabled: !!activeStoreId,
    queryFn: () => apiRequest<{ products: Product[] }>(`/products${q ? `?${q}` : ""}`),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (editing) {
        return apiRequest<{ product: Product }>(`/products/${editing.id}`, {
          method: "PATCH",
          body: {
            sku: form.sku,
            name: form.name,
            category: form.category,
            price: Number(form.price),
            cost: Number(form.cost),
            reorderAt: Number(form.reorderAt),
            taxExempt: form.taxExempt,
            ...(activeStoreId ? { storeId: activeStoreId } : {}),
          },
        });
      }
      return apiRequest<{ product: Product }>("/products", {
        method: "POST",
        body: {
          sku: form.sku,
          name: form.name,
          category: form.category,
          price: Number(form.price),
          cost: Number(form.cost),
          stock: Number(form.stock),
          reorderAt: Number(form.reorderAt),
          taxExempt: form.taxExempt,
          ...(activeStoreId ? { storeId: activeStoreId } : {}),
        },
      });
    },
    onSuccess: () => {
      setForm(emptyForm);
      setEditing(null);
      setError(null);
      void qc.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Save failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(`/products/${id}${q ? `?${q}` : ""}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["products"] }),
    onError: (err) => setError(err instanceof ApiError ? err.message : "Delete failed"),
  });

  function startEdit(p: Product) {
    setEditing(p);
    setForm({
      sku: p.sku,
      name: p.name,
      category: p.category,
      price: String(p.price),
      cost: String(p.cost),
      stock: String(p.stock),
      reorderAt: String(p.reorderAt),
      taxExempt: Boolean(p.taxExempt),
    });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    saveMutation.mutate();
  }

  if (!activeStoreId) {
    return <p className="text-stone-600">Select a store to manage inventory.</p>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>
      <p className="text-sm text-stone-600">
        Expand a product to see lots. Amber = near expiry (≤14 days). Red = quarantined /
        recalled.
      </p>

      {canEdit && (
        <form
          onSubmit={onSubmit}
          className="grid gap-3 rounded-lg border border-stone-200 bg-white p-4 sm:grid-cols-4"
        >
          <h2 className="sm:col-span-4 font-medium">
            {editing ? `Edit ${editing.sku}` : "Add product"}
          </h2>
          {(
            [
              ["sku", "SKU"],
              ["name", "Name"],
              ["category", "Category"],
              ["price", "Price"],
              ["cost", "Cost"],
              ["stock", "Stock"],
              ["reorderAt", "Reorder at"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="text-sm">
              {label}
              <input
                className="mt-1 w-full rounded border border-stone-300 px-2 py-1"
                value={form[key]}
                disabled={Boolean(editing && key === "stock")}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                required
              />
            </label>
          ))}
          <label className="flex items-end gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={form.taxExempt}
              onChange={(e) => setForm((f) => ({ ...f, taxExempt: e.target.checked }))}
            />
            Tax exempt (e.g. groceries)
          </label>
          <div className="flex items-end gap-2 sm:col-span-4">
            <button
              type="submit"
              className="rounded bg-stone-900 px-4 py-2 text-white"
              disabled={saveMutation.isPending}
            >
              {editing ? "Update" : "Create"}
            </button>
            {editing && (
              <button
                type="button"
                className="rounded border border-stone-300 px-4 py-2"
                onClick={() => {
                  setEditing(null);
                  setForm(emptyForm);
                }}
              >
                Cancel
              </button>
            )}
          </div>
          {error && <p className="sm:col-span-4 text-sm text-red-700">{error}</p>}
        </form>
      )}

      <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-stone-200 bg-stone-50 text-stone-600">
            <tr>
              <th className="px-3 py-2 w-8" />
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Price</th>
              <th className="px-3 py-2">Tax</th>
              <th className="px-3 py-2">Stock</th>
              <th className="px-3 py-2">Status</th>
              {canEdit && <th className="px-3 py-2">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {(productsQuery.data?.products ?? []).map((p) => {
              const open = expandedId === p.id;
              return (
                <Fragment key={p.id}>
                  <tr className="border-b border-stone-100">
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className="font-mono text-stone-500"
                        aria-expanded={open}
                        onClick={() => setExpandedId(open ? null : p.id)}
                      >
                        {open ? "▾" : "▸"}
                      </button>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{p.sku}</td>
                    <td className="px-3 py-2">{p.name}</td>
                    <td className="px-3 py-2">{p.category}</td>
                    <td className="px-3 py-2">{money(p.price)}</td>
                    <td className="px-3 py-2">{p.taxExempt ? "Exempt" : "Taxable"}</td>
                    <td className="px-3 py-2">
                      {p.available ?? p.stock}
                      {(p.reserved ?? 0) > 0 ? (
                        <span className="ml-1 text-xs text-stone-400">
                          ({p.reserved} reserved)
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      {p.lowStock ? (
                        <span className="text-amber-700">Low</span>
                      ) : (
                        <span className="text-stone-500">OK</span>
                      )}
                    </td>
                    {canEdit && (
                      <td className="space-x-2 px-3 py-2">
                        <button type="button" className="underline" onClick={() => startEdit(p)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="text-red-700 underline"
                          onClick={() => {
                            if (confirm(`Delete ${p.name}?`)) deleteMutation.mutate(p.id);
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    )}
                  </tr>
                  {open && (
                    <tr className="border-b border-stone-200 bg-stone-50">
                      <td colSpan={canEdit ? 9 : 8} className="px-0 py-0">
                        <ProductLots productId={p.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
