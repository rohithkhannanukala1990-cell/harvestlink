/**
 * Inventory management page.
 *
 * APIs:
 * - GET /products — list (CASHIER can view; STORE_ADMIN / COOP_ADMIN manage)
 * - POST /products — create (STORE_ADMIN, COOP_ADMIN)
 * - PATCH /products/:id — edit (STORE_ADMIN, COOP_ADMIN)
 * - DELETE /products/:id — remove (STORE_ADMIN, COOP_ADMIN)
 *
 * Cashiers see a read-only table; mutation controls are hidden for CASHIER.
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest, money } from "../api/client";
import type { Product } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { storeQuery } from "../auth/storeQuery";

const emptyForm = {
  sku: "",
  name: "",
  category: "",
  price: "",
  cost: "",
  stock: "0",
  reorderAt: "5",
};

export function InventoryPage() {
  const { activeStoreId, isRole } = useAuth();
  const canEdit = isRole("STORE_ADMIN", "COOP_ADMIN");
  const qc = useQueryClient();
  const q = storeQuery(activeStoreId);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<Product | null>(null);
  const [error, setError] = useState<string | null>(null);

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
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Price</th>
              <th className="px-3 py-2">Stock</th>
              <th className="px-3 py-2">Status</th>
              {canEdit && <th className="px-3 py-2">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {(productsQuery.data?.products ?? []).map((p) => (
              <tr key={p.id} className="border-b border-stone-100">
                <td className="px-3 py-2 font-mono text-xs">{p.sku}</td>
                <td className="px-3 py-2">{p.name}</td>
                <td className="px-3 py-2">{p.category}</td>
                <td className="px-3 py-2">{money(p.price)}</td>
                <td className="px-3 py-2">{p.stock}</td>
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
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
