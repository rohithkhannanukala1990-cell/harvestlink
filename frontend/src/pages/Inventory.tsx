/**
 * Inventory management page.
 *
 * Expand a product to see its barcodes and lots — lot number, qty, expiry, supplier, status.
 * Near-expiry and quarantined/recalled lots use StatusBadge (word + tone).
 *
 * Barcodes: a product can carry several (manufacturer UPC/EAN, case GTIN, store codes); the SKU is
 * always scannable too. Scanning anywhere on the page opens the product; the product form and the
 * "Add barcode" box are excluded so a scan there types into the field instead.
 *
 * Manual stock changes adjust a specific lot (every unit lives in a lot).
 */
import { useCallback, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "../api/client";
import type { CatalogItem, Lot, Product, ProductBarcode } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { storeQuery } from "../auth/storeQuery";
import { formatExpiry } from "../lib/lotDisplay";
import { lookupBarcode } from "../scanner/lookup";
import { useScanner } from "../scanner/useScanner";
import {
  Button,
  Card,
  DataTable,
  Field,
  LotStatusBadge,
  Money,
  PageHeader,
  StatusBadge,
  UnitCost,
  formatMoney,
  isLotBlockedFromSale,
  type DataTableColumn,
} from "../components/ui";

const emptyForm = {
  catalogItemId: "",
  price: "",
  cost: "",
  stock: "0",
  reorderAt: "5",
};

function ProductBarcodes({ productId, canEdit }: { productId: string; canEdit: boolean }) {
  const { activeStoreId } = useAuth();
  const qc = useQueryClient();
  const q = storeQuery(activeStoreId);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const queryKey = ["products", productId, "barcodes", activeStoreId];

  const barcodesQuery = useQuery({
    queryKey,
    enabled: !!activeStoreId,
    queryFn: () =>
      apiRequest<{ barcodes: ProductBarcode[] }>(`/barcodes/products/${productId}${q ? `?${q}` : ""}`),
  });

  const add = useMutation({
    mutationFn: () =>
      apiRequest<{ barcode: ProductBarcode }>(`/barcodes/products/${productId}`, {
        method: "POST",
        body: {
          code,
          label: label.trim() || null,
          ...(activeStoreId ? { storeId: activeStoreId } : {}),
        },
      }),
    onSuccess: () => {
      setCode("");
      setLabel("");
      setError(null);
      void qc.invalidateQueries({ queryKey });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not add the barcode"),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(`/barcodes/${id}${q ? `?${q}` : ""}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey }),
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not remove the barcode"),
  });

  const barcodes = barcodesQuery.data?.barcodes ?? [];

  return (
    <div className="space-y-2 px-3 pt-3">
      <h3 className="text-sm font-semibold text-ink">Barcodes</h3>
      {barcodesQuery.isLoading ? (
        <p className="text-sm text-ink-muted">Loading barcodes…</p>
      ) : barcodes.length === 0 ? (
        <p className="text-sm text-ink-muted">No barcodes yet — only the SKU scans to this product.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {barcodes.map((b) => (
            <li
              key={b.id}
              className="inline-flex items-center gap-2 rounded-md border border-border-hairline bg-surface-raised px-2 py-1 text-sm"
            >
              <span className="font-mono">{b.code}</span>
              <StatusBadge label={b.kind === "GTIN" ? "UPC/EAN" : "Store code"} tone="neutral" />
              {b.label && <span className="text-ink-muted">{b.label}</span>}
              {canEdit && (
                <button
                  type="button"
                  className="text-xs font-semibold text-state-danger underline"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (confirm(`Remove barcode ${b.code}?`)) remove.mutate(b.id);
                  }}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form
          data-scanner="off"
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) add.mutate();
          }}
        >
          <Field
            label="Add barcode (scan or type)"
            className="min-w-[14rem]"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
          />
          <Field
            label="Note (optional)"
            className="min-w-[10rem]"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. case of 12"
          />
          <Button type="submit" loading={add.isPending}>
            Add
          </Button>
        </form>
      )}
      {error && (
        <p className="text-sm text-state-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ProductLots({ productId, canEdit }: { productId: string; canEdit: boolean }) {
  const { activeStoreId } = useAuth();
  const qc = useQueryClient();
  const q = storeQuery(activeStoreId);
  const [adjustLotId, setAdjustLotId] = useState("");
  const [newQuantity, setNewQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [adjustError, setAdjustError] = useState<string | null>(null);

  const lotsQuery = useQuery({
    queryKey: ["products", productId, "lots", activeStoreId],
    enabled: !!activeStoreId,
    queryFn: () =>
      apiRequest<{ lots: Lot[] }>(`/products/${productId}/lots${q ? `?${q}` : ""}`),
  });

  const adjustMutation = useMutation({
    mutationFn: () =>
      apiRequest(`/products/${productId}/stock`, {
        method: "PATCH",
        body: {
          lotId: adjustLotId,
          newQuantity: Number(newQuantity),
          reason,
          ...(activeStoreId ? { storeId: activeStoreId } : {}),
        },
      }),
    onSuccess: () => {
      setNewQuantity("");
      setReason("");
      setAdjustError(null);
      void qc.invalidateQueries({ queryKey: ["products", productId, "lots"] });
      void qc.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (err) =>
      setAdjustError(err instanceof ApiError ? err.message : "Could not adjust lot quantity"),
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
      id: "cost",
      header: "Unit cost",
      numeric: true,
      cell: (lot) =>
        lot.unitCost != null ? <UnitCost value={lot.unitCost} /> : <span className="text-ink-muted">—</span>,
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
    <div className="space-y-3 p-2">
      <DataTable
        columns={columns}
        rows={lots}
        rowKey={(lot) => lot.id}
        emptyMessage="No lots"
        className="border-0"
      />
      {canEdit && (
        <form
          data-scanner="off"
          className="flex flex-wrap items-end gap-2 border-t border-border-hairline pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (adjustLotId && reason.trim()) adjustMutation.mutate();
          }}
        >
          <label className="block text-sm text-ink">
            <span className="mb-1 block font-medium">Adjust lot</span>
            <select
              className="rounded-md border border-border-strong bg-surface-raised px-3 py-2"
              value={adjustLotId}
              onChange={(e) => {
                const id = e.target.value;
                setAdjustLotId(id);
                const lot = lots.find((l) => l.id === id);
                if (lot) setNewQuantity(String(lot.quantityRemaining));
              }}
              required
            >
              <option value="">Select lot…</option>
              {lots.map((lot) => (
                <option key={lot.id} value={lot.id}>
                  {lot.lotNumber} ({lot.status}, qty {lot.quantityRemaining})
                </option>
              ))}
            </select>
          </label>
          <Field
            label="New quantity"
            type="number"
            min={0}
            step={1}
            className="w-28"
            value={newQuantity}
            onChange={(e) => setNewQuantity(e.target.value)}
            required
          />
          <Field
            label="Reason"
            className="min-w-[12rem]"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
          />
          <Button type="submit" loading={adjustMutation.isPending}>
            Adjust
          </Button>
          {adjustError && (
            <p className="basis-full text-sm text-state-danger" role="alert">
              {adjustError}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

export function InventoryPage() {
  const { activeStoreId, isRole } = useAuth();
  const canEdit = isRole("STORE_ADMIN", "COOP_ADMIN");
  const canEditCost = isRole("COOP_ADMIN");
  const qc = useQueryClient();
  const q = storeQuery(activeStoreId);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<Product | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  const handleScan = useCallback(
    async (raw: string) => {
      try {
        const result = await lookupBarcode(activeStoreId, raw);
        const match = result.matches[0];
        if (!match) {
          setScanMessage(`No product in this store has barcode ${result.code}`);
          return;
        }
        setExpandedId(match.product.id);
        setScanMessage(`${match.product.name} (${match.product.sku})`);
      } catch (err) {
        setScanMessage(err instanceof ApiError ? err.message : "Barcode lookup failed");
      }
    },
    [activeStoreId],
  );

  useScanner(
    useCallback((raw: string) => void handleScan(raw), [handleScan]),
    { enabled: !!activeStoreId },
  );

  const productsQuery = useQuery({
    queryKey: ["products", activeStoreId],
    enabled: !!activeStoreId,
    queryFn: () => apiRequest<{ products: Product[] }>(`/products${q ? `?${q}` : ""}`),
  });

  const catalogQuery = useQuery({
    queryKey: ["catalog"],
    enabled: canEdit,
    queryFn: () => apiRequest<{ items: CatalogItem[] }>("/catalog"),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (editing) {
        return apiRequest<{ product: Product }>(`/products/${editing.id}`, {
          method: "PATCH",
          body: {
            price: Number(form.price),
            ...(canEditCost ? { cost: Number(form.cost) } : {}),
            reorderAt: Number(form.reorderAt),
            ...(activeStoreId ? { storeId: activeStoreId } : {}),
          },
        });
      }
      return apiRequest<{ product: Product }>("/products", {
        method: "POST",
        body: {
          catalogItemId: form.catalogItemId,
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
      catalogItemId: p.catalogItemId ?? "",
      price: String(p.price),
      cost: String(p.cost ?? ""),
      stock: String(p.stock),
      reorderAt: String(p.reorderAt),
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
      id: "cost",
      header: "Cost",
      numeric: true,
      cell: (p) =>
        p.cost != null ? <UnitCost value={p.cost} /> : <span className="text-ink-muted">—</span>,
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

  const formFields = (
    [
      ["price", "Price"],
      ...(!editing || canEditCost ? ([["cost", "Cost"]] as const) : []),
      ...(!editing ? ([["stock", "Opening stock"]] as const) : []),
      ["reorderAt", "Reorder at"],
    ] as const
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory"
        description="Scan a barcode to open its product, or expand one to see its barcodes and lots. Status badges name the state — colour is secondary."
      />

      {scanMessage && (
        <p className="rounded-md border border-border-hairline bg-surface-raised px-3 py-2 text-sm text-ink">
          {scanMessage}
        </p>
      )}

      {canEdit && (
        <Card title={editing ? `Edit ${editing.sku}` : "Add product"}>
          <p className="mb-3 text-sm text-ink-muted">
            SKU name, category and tax status come from the network catalog. Price must stay at or
            below the co-op shelf ceiling. Opening stock creates an OPENING lot; later quantity
            changes adjust a lot. Cost edits after create are COOP_ADMIN only.
          </p>
          <form onSubmit={onSubmit} data-scanner="off" className="grid gap-3 sm:grid-cols-4">
            {!editing && (
              <label className="block text-sm text-ink sm:col-span-2">
                <span className="mb-1 block font-medium">Catalog SKU</span>
                <select
                  className="w-full rounded-md border border-border-strong bg-surface-raised px-3 py-2"
                  value={form.catalogItemId}
                  onChange={(e) => setForm((f) => ({ ...f, catalogItemId: e.target.value }))}
                  required
                >
                  <option value="">Select catalog item…</option>
                  {(catalogQuery.data?.items ?? [])
                    .filter((i) => i.isActive !== false)
                    .map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.sku} — {i.name} (max {formatMoney(i.maxShelfPrice)})
                      </option>
                    ))}
                </select>
              </label>
            )}
            {formFields.map(([key, label]) => (
              <Field
                key={key}
                label={label}
                value={form[key]}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                required
              />
            ))}
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
          render: (p) => (
            <>
              <ProductBarcodes productId={p.id} canEdit={canEdit} />
              <ProductLots productId={p.id} canEdit={canEdit} />
            </>
          ),
        }}
      />
    </div>
  );
}
