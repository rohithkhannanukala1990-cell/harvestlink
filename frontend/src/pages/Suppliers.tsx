/**
 * Suppliers list + detail (link preferred products / costs).
 */
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "../api/client";
import type { Product, Supplier } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { storeQuery } from "../auth/storeQuery";
import {
  Button,
  Card,
  DataTable,
  Field,
  Money,
  PageHeader,
  SelectField,
  StatusBadge,
  type DataTableColumn,
} from "../components/ui";

export function SuppliersPage() {
  const { id } = useParams();
  if (id) return <SupplierDetail id={id} />;
  return <SupplierList />;
}

function SupplierList() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["suppliers"],
    queryFn: () => apiRequest<{ suppliers: Supplier[] }>("/purchasing/suppliers"),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      apiRequest<{ supplier: Supplier }>("/purchasing/suppliers", {
        method: "POST",
        body: { name },
      }),
    onSuccess: () => {
      setName("");
      setError(null);
      void qc.invalidateQueries({ queryKey: ["suppliers"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Create failed"),
  });

  const suppliers = listQuery.data?.suppliers ?? [];

  const columns: DataTableColumn<Supplier>[] = [
    {
      id: "name",
      header: "Name",
      cell: (s) => (
        <Link
          className="font-semibold text-ink underline decoration-brand-terracotta-ink/40"
          to={`/suppliers/${s.id}`}
        >
          {s.name}
        </Link>
      ),
    },
    { id: "terms", header: "Terms", cell: (s) => s.paymentTerms },
    {
      id: "lead",
      header: "Lead days",
      numeric: true,
      cell: (s) => <span className="tabular">{s.leadTimeDays}</span>,
    },
    {
      id: "status",
      header: "Status",
      cell: (s) =>
        s.isActive ? (
          <StatusBadge label="Active" tone="success" />
        ) : (
          <StatusBadge label="Closed" tone="neutral" />
        ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Suppliers" />
      <Card title="Add supplier">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            createMutation.mutate();
          }}
        >
          <Field
            label="New supplier name"
            className="min-w-[220px] flex-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <div className="flex items-end">
            <Button type="submit" loading={createMutation.isPending}>
              Add supplier
            </Button>
          </div>
          {error && (
            <p className="w-full text-sm text-state-danger" role="alert">
              {error}
            </p>
          )}
        </form>
      </Card>
      <DataTable
        columns={columns}
        rows={suppliers}
        rowKey={(s) => s.id}
        emptyMessage="No suppliers yet"
      />
    </div>
  );
}

function SupplierDetail({ id }: { id: string }) {
  const { activeStoreId } = useAuth();
  const qc = useQueryClient();
  const q = storeQuery(activeStoreId);
  const [form, setForm] = useState({
    contactName: "",
    email: "",
    phone: "",
    address: "",
    paymentTerms: "NET30",
    leadTimeDays: "7",
    notes: "",
  });
  const [link, setLink] = useState({
    productId: "",
    unitCost: "",
    caseSize: "1",
    caseCost: "",
    minOrderQty: "1",
    supplierSku: "",
    isPreferred: true,
  });
  const [message, setMessage] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ["supplier", id],
    queryFn: async () => {
      const data = await apiRequest<{ supplier: Supplier }>(`/purchasing/suppliers/${id}`);
      setForm({
        contactName: data.supplier.contactName,
        email: data.supplier.email,
        phone: data.supplier.phone,
        address: data.supplier.address,
        paymentTerms: data.supplier.paymentTerms,
        leadTimeDays: String(data.supplier.leadTimeDays),
        notes: data.supplier.notes,
      });
      return data;
    },
  });

  const productsQuery = useQuery({
    queryKey: ["products", activeStoreId],
    enabled: !!activeStoreId,
    queryFn: () => apiRequest<{ products: Product[] }>(`/products${q ? `?${q}` : ""}`),
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      apiRequest<{ supplier: Supplier }>(`/purchasing/suppliers/${id}`, {
        method: "PATCH",
        body: {
          ...form,
          leadTimeDays: Number(form.leadTimeDays),
        },
      }),
    onSuccess: () => {
      setMessage("Supplier saved");
      void qc.invalidateQueries({ queryKey: ["supplier", id] });
    },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : "Save failed"),
  });

  const linkMutation = useMutation({
    mutationFn: () =>
      apiRequest("/purchasing/supplier-products", {
        method: "POST",
        body: {
          supplierId: id,
          productId: link.productId,
          supplierSku: link.supplierSku,
          caseSize: Number(link.caseSize),
          caseCost: Number(link.caseCost || link.unitCost),
          unitCost: Number(link.unitCost),
          minOrderQty: Number(link.minOrderQty),
          isPreferred: link.isPreferred,
        },
      }),
    onSuccess: () => {
      setMessage("Product linked");
      void qc.invalidateQueries({ queryKey: ["supplier", id] });
    },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : "Link failed"),
  });

  const supplier = detailQuery.data?.supplier;

  return (
    <div className="space-y-6">
      <PageHeader
        title={supplier?.name ?? "…"}
        description={
          <Link to="/suppliers" className="text-brand-terracotta-ink underline">
            ← Suppliers
          </Link>
        }
      />
      {message && <p className="text-sm text-ink-muted">{message}</p>}

      <Card title="Supplier details">
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            saveMutation.mutate();
          }}
        >
          {(
            [
              ["contactName", "Contact"],
              ["email", "Email"],
              ["phone", "Phone"],
              ["address", "Address"],
              ["paymentTerms", "Payment terms"],
              ["leadTimeDays", "Lead time (days)"],
            ] as const
          ).map(([key, label]) => (
            <Field
              key={key}
              label={label}
              value={form[key]}
              onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
            />
          ))}
          <label className="flex flex-col gap-1.5 text-sm sm:col-span-2">
            <span className="font-semibold text-ink">Notes</span>
            <textarea
              className="w-full rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm text-ink"
              rows={2}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </label>
          <div className="sm:col-span-2">
            <Button type="submit" loading={saveMutation.isPending}>
              Save supplier
            </Button>
          </div>
        </form>
      </Card>

      <Card title="Linked products">
        <ul className="mb-4 space-y-2 text-sm">
          {(supplier?.products ?? []).map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap justify-between gap-2 border-b border-border-hairline pb-2"
            >
              <span className="text-ink">
                {p.product.sku} — {p.product.name}
                {p.isPreferred ? " · preferred" : ""}
              </span>
              <span className="text-ink-muted">
                unit <Money value={p.unitCost} /> · case{" "}
                <span className="tabular">{p.caseSize}</span> · min{" "}
                <span className="tabular">{p.minOrderQty}</span>
              </span>
            </li>
          ))}
          {(supplier?.products ?? []).length === 0 && (
            <li className="text-ink-muted">No products linked yet.</li>
          )}
        </ul>

        <div className="grid gap-2 border-t border-border-hairline pt-3 sm:grid-cols-3">
          <SelectField
            label="Product"
            value={link.productId}
            onChange={(e) => setLink((l) => ({ ...l, productId: e.target.value }))}
          >
            <option value="">Select product…</option>
            {(productsQuery.data?.products ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.sku} — {p.name}
              </option>
            ))}
          </SelectField>
          <Field
            label="Unit cost"
            value={link.unitCost}
            onChange={(e) => setLink((l) => ({ ...l, unitCost: e.target.value }))}
          />
          <Field
            label="Case size"
            value={link.caseSize}
            onChange={(e) => setLink((l) => ({ ...l, caseSize: e.target.value }))}
          />
          <label className="flex items-center gap-2 text-sm text-ink sm:col-span-2">
            <input
              type="checkbox"
              checked={link.isPreferred}
              onChange={(e) => setLink((l) => ({ ...l, isPreferred: e.target.checked }))}
            />
            Preferred supplier for this product
          </label>
          <div className="flex items-end">
            <Button
              type="button"
              disabled={!link.productId || !link.unitCost}
              loading={linkMutation.isPending}
              onClick={() => linkMutation.mutate()}
            >
              Link product
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
