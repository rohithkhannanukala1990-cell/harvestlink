/**
 * Suppliers list + detail (link preferred products / costs).
 */
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest, money } from "../api/client";
import type { Product, Supplier } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { storeQuery } from "../auth/storeQuery";

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

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Suppliers</h1>
      <form
        className="flex flex-wrap gap-2 rounded-lg border border-stone-200 bg-white p-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          createMutation.mutate();
        }}
      >
        <input
          className="min-w-[220px] flex-1 rounded border border-stone-300 px-3 py-2"
          placeholder="New supplier name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button type="submit" className="rounded bg-stone-900 px-4 py-2 text-white">
          Add supplier
        </button>
        {error && <p className="w-full text-sm text-red-700">{error}</p>}
      </form>
      <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b bg-stone-50 text-stone-600">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Terms</th>
              <th className="px-3 py-2">Lead days</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {(listQuery.data?.suppliers ?? []).map((s) => (
              <tr key={s.id}>
                <td className="px-3 py-2">
                  <Link className="font-medium text-stone-900 underline" to={`/suppliers/${s.id}`}>
                    {s.name}
                  </Link>
                </td>
                <td className="px-3 py-2">{s.paymentTerms}</td>
                <td className="px-3 py-2">{s.leadTimeDays}</td>
                <td className="px-3 py-2">{s.isActive ? "Active" : "Inactive"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
      <div className="flex items-center gap-3">
        <Link to="/suppliers" className="text-sm text-stone-600 underline">
          ← Suppliers
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{supplier?.name ?? "…"}</h1>
      </div>
      {message && <p className="text-sm text-stone-600">{message}</p>}

      <form
        className="grid gap-3 rounded-lg border border-stone-200 bg-white p-4 sm:grid-cols-2"
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
          <label key={key} className="text-sm">
            {label}
            <input
              className="mt-1 w-full rounded border border-stone-300 px-2 py-1"
              value={form[key]}
              onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
            />
          </label>
        ))}
        <label className="text-sm sm:col-span-2">
          Notes
          <textarea
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1"
            rows={2}
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          />
        </label>
        <button type="submit" className="rounded bg-stone-900 px-4 py-2 text-white sm:col-span-2">
          Save supplier
        </button>
      </form>

      <section className="space-y-3 rounded-lg border border-stone-200 bg-white p-4">
        <h2 className="font-medium">Linked products</h2>
        <ul className="space-y-2 text-sm">
          {(supplier?.products ?? []).map((p) => (
            <li key={p.id} className="flex flex-wrap justify-between gap-2 border-b border-stone-100 pb-2">
              <span>
                {p.product.sku} — {p.product.name}
                {p.isPreferred ? " · preferred" : ""}
              </span>
              <span>
                unit {money(p.unitCost)} · case {p.caseSize} · min {p.minOrderQty}
              </span>
            </li>
          ))}
        </ul>

        <div className="grid gap-2 border-t border-stone-100 pt-3 sm:grid-cols-3">
          <select
            className="rounded border border-stone-300 px-2 py-2"
            value={link.productId}
            onChange={(e) => setLink((l) => ({ ...l, productId: e.target.value }))}
          >
            <option value="">Select product…</option>
            {(productsQuery.data?.products ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.sku} — {p.name}
              </option>
            ))}
          </select>
          <input
            className="rounded border border-stone-300 px-2 py-2"
            placeholder="Unit cost"
            value={link.unitCost}
            onChange={(e) => setLink((l) => ({ ...l, unitCost: e.target.value }))}
          />
          <input
            className="rounded border border-stone-300 px-2 py-2"
            placeholder="Case size"
            value={link.caseSize}
            onChange={(e) => setLink((l) => ({ ...l, caseSize: e.target.value }))}
          />
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={link.isPreferred}
              onChange={(e) => setLink((l) => ({ ...l, isPreferred: e.target.checked }))}
            />
            Preferred supplier for this product
          </label>
          <button
            type="button"
            className="rounded bg-stone-800 px-4 py-2 text-white"
            disabled={!link.productId || !link.unitCost}
            onClick={() => linkMutation.mutate()}
          >
            Link product
          </button>
        </div>
      </section>
    </div>
  );
}
