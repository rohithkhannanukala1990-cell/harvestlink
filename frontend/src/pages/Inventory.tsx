/**
 * Inventory management page.
 *
 * Expand a product to see lots — lot number, qty, expiry, supplier, status.
 * Near-expiry and quarantined/recalled lots use StatusBadge (word + tone).
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "../api/client";
import type { Lot, Product } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { storeQuery } from "../auth/storeQuery";
import { formatExpiry } from "../lib/lotDisplay";
import {
  Button,
  Card,
  DataTable,
  Field,
  LotStatusBadge,
  Money,
  PageHeader,
  StatusBadge,
  isLotBlockedFromSale,
  type DataTableColumn,
} from "../components/ui";

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
    return <p className="px-3 py-2 text-sm text-ink-muted">Loading lots…</p>;
  }
  const lots = lotsQuery.data?.lots ?? [];
  if (!lots.length) {
    return <p className="px-3 py-2 text-sm text-ink-muted">No lots for this product.</p>;
  }

  const columns: DataTableColumn<Lot>[] = [
    {
      id: "lot",
      header: "Lot #",
      cell: (lot) => <span className="font-mono">{lot.lotNumber}</span>,
    },
    {
      id: "qty",
      header: "Qty",
      numeric: true,
      cell: (lot) => (
        <span className="tabular">
          {lot.quantityRemaining}
          {lot.quantityReserved > 0 ? (
            <span className="ml-1 text-ink-muted">
              (<span className="tabular">({lot.quantityReserved}</span> held)
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "expiry",
      header: "Expiry",
      cell: (lot) => formatExpiry(lot.expiryDate, lot.daysUntilExpiry),
    },
    {
      id: "supplier",
      header: "Supplier",
      cell: (lot) => lot.supplier?.name ?? "—",
    },
    {
      id: "status",
      header: "Status",
      cell: (lot) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <LotStatusBadge
            status={lot.status}
            nearExpiry={
              lot.status === "ACTIVE" &&
              lot.daysUntilExpiry != null &&
              lot.daysUntilExpiry <= 14
            }
          />
          {isLotBlockedFromSale(lot.status) && (
            <span className="text-xs font-semibold text-state-danger">Not for sale</span>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="p-2">
      <DataTable
        columns={columns}
        rows={lots}
        rowKey={(lot) => lot.id}
        emptyMessage="No lots"
        className="border-0"
      />
    </div>
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
    return <p className="text-ink-muted">Select a store to manage inventory.</p>;
  }

  const products = productsQuery.data?.products ?? [];

  const columns: DataTableColumn<Product>[] = [
    {
      id: "sku",
      header: "SKU",
      cell: (p) => <span className="font-mono text-xs">{p.sku}</span>,
    },
    { id: "name", header: "Name", cell: (p) => p.name },
    { id: "category", header: "Category", cell: (p) => p.category },
    {
      id: "price",
      header: "Price",
      numeric: true,
      cell: (p) => <Money value={p.price} />,
    },
    {
      id: "tax",
      header: "Tax",
      cell: (p) => (p.taxExempt ? "Exempt" : "Taxable"),
    },
    {
      id: "stock",
      header: "Stock",
      numeric: true,
      cell: (p) => (
        <span className="tabular">
          {p.available ?? p.stock}
          {(p.reserved ?? 0) > 0 ? (
            <span className="ml-1 text-xs text-ink-muted">
              (<span className="tabular">({p.reserved}</span> reserved)
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (p) =>
        p.lowStock ? (
          <StatusBadge label="Low stock" tone="warning" />
        ) : (
          <span className="text-ink-muted">OK</span>
        ),
    },
    ...(canEdit
      ? [
          {
            id: "actions",
            header: "Actions",
            cell: (p: Product) => (
              <span className="inline-flex flex-wrap gap-2">
                <Button type="button" variant="quiet" onClick={() => startEdit(p)}>
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    if (confirm(`Delete ${p.name}?`)) deleteMutation.mutate(p.id);
                  }}
                >
                  Delete
                </Button>
              </span>
            ),
          } satisfies DataTableColumn<Product>,
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory"
        description="Expand a product to see lots. Status badges name the state — colour is secondary."
      />

      {canEdit && (
        <Card title={editing ? `Edit ${editing.sku}` : "Add product"}>
          <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-4">
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
              <Field
                key={key}
                label={label}
                value={form[key]}
                disabled={Boolean(editing && key === "stock")}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                required
              />
            ))}
            <label className="flex items-end gap-2 text-sm text-ink sm:col-span-2">
              <input
                type="checkbox"
                checked={form.taxExempt}
                onChange={(e) => setForm((f) => ({ ...f, taxExempt: e.target.checked }))}
              />
              Tax exempt (e.g. groceries)
            </label>
            <div className="flex items-end gap-2 sm:col-span-4">
              <Button type="submit" loading={saveMutation.isPending}>
                {editing ? "Update" : "Create"}
              </Button>
              {editing && (
                <Button
                  type="button"
                  variant="quiet"
                  onClick={() => {
                    setEditing(null);
                    setForm(emptyForm);
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
            {error && (
              <p className="sm:col-span-4 text-sm text-state-danger" role="alert">
                {error}
              </p>
            )}
          </form>
        </Card>
      )}

      <DataTable
        columns={columns}
        rows={products}
        rowKey={(p) => p.id}
        emptyMessage="No products"
        expandable={{
          isExpanded: (p) => expandedId === p.id,
          onToggle: (p) => setExpandedId(expandedId === p.id ? null : p.id),
          render: (p) => <ProductLots productId={p.id} />,
        }}
      />
    </div>
  );
}
