/**
 * Network catalog (COOP_ADMIN) — pack sizes, shelf ceilings, backfill disagreements.
 */
import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "../api/client";
import type { CatalogDisagreement, CatalogItem } from "../api/types";
import {
  Button,
  Card,
  DataTable,
  Field,
  Money,
  PageHeader,
  StatusBadge,
  type DataTableColumn,
} from "../components/ui";

const emptyForm = {
  sku: "",
  name: "",
  category: "",
  unitsPerCase: "1",
  casesPerPallet: "",
  caseWeightKg: "",
  caseGtin: "",
  maxShelfPrice: "",
  taxExempt: false,
  isActive: true,
};

export function CatalogPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<CatalogItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const itemsQuery = useQuery({
    queryKey: ["catalog"],
    queryFn: () => apiRequest<{ items: CatalogItem[] }>("/catalog"),
  });

  const disagreementsQuery = useQuery({
    queryKey: ["catalog", "disagreements"],
    queryFn: () =>
      apiRequest<{ disagreements: CatalogDisagreement[] }>("/catalog/disagreements"),
  });

  const resolveMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest<{ disagreement: CatalogDisagreement }>(`/catalog/disagreements/${id}/resolve`, {
        method: "POST",
        body: {},
      }),
    onSuccess: () => {
      setMessage("Disagreement marked resolved.");
      void qc.invalidateQueries({ queryKey: ["catalog", "disagreements"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Resolve failed"),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = {
        sku: form.sku,
        name: form.name,
        category: form.category,
        unitsPerCase: Number(form.unitsPerCase),
        casesPerPallet: form.casesPerPallet.trim()
          ? Number(form.casesPerPallet)
          : null,
        caseWeightKg: form.caseWeightKg.trim() ? Number(form.caseWeightKg) : null,
        caseGtin: form.caseGtin.trim() || null,
        maxShelfPrice: Number(form.maxShelfPrice),
        taxExempt: form.taxExempt,
        isActive: form.isActive,
      };
      if (editing) {
        return apiRequest<{ item: CatalogItem }>(`/catalog/${editing.id}`, {
          method: "PATCH",
          body,
        });
      }
      return apiRequest<{ item: CatalogItem }>("/catalog", { method: "POST", body });
    },
    onSuccess: () => {
      setForm(emptyForm);
      setEditing(null);
      setError(null);
      setMessage(editing ? "Catalog item updated (prices clamped if ceiling dropped)." : "Catalog item created.");
      void qc.invalidateQueries({ queryKey: ["catalog"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Save failed"),
  });

  function startEdit(item: CatalogItem) {
    setEditing(item);
    setForm({
      sku: item.sku,
      name: item.name,
      category: item.category,
      unitsPerCase: String(item.unitsPerCase),
      casesPerPallet: item.casesPerPallet != null ? String(item.casesPerPallet) : "",
      caseWeightKg: item.caseWeightKg != null ? String(item.caseWeightKg) : "",
      caseGtin: item.caseGtin ?? "",
      maxShelfPrice: String(item.maxShelfPrice),
      taxExempt: Boolean(item.taxExempt),
      isActive: item.isActive !== false,
    });
    setMessage(null);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    saveMutation.mutate();
  }

  const columns: DataTableColumn<CatalogItem>[] = useMemo(
    () => [
      {
        id: "sku",
        header: "SKU",
        cell: (i) => <span className="font-mono text-xs">{i.sku}</span>,
      },
      { id: "name", header: "Name", cell: (i) => i.name },
      { id: "category", header: "Category", cell: (i) => i.category },
      {
        id: "pack",
        header: "Pack",
        numeric: true,
        cell: (i) => (
          <span className="tabular">
            {i.unitsPerCase}/case
            {i.casesPerPallet != null ? ` · ${i.casesPerPallet}/pallet` : ""}
          </span>
        ),
      },
      {
        id: "ceiling",
        header: "Max shelf",
        numeric: true,
        cell: (i) => <Money value={i.maxShelfPrice} />,
      },
      {
        id: "status",
        header: "Status",
        cell: (i) =>
          i.isActive === false ? (
            <StatusBadge label="Inactive" tone="neutral" />
          ) : i.taxExempt ? (
            <StatusBadge label="Tax exempt" tone="neutral" />
          ) : (
            <span className="text-ink-muted">Active</span>
          ),
      },
      {
        id: "actions",
        header: "",
        cell: (i) => (
          <Button type="button" variant="quiet" onClick={() => startEdit(i)}>
            Edit
          </Button>
        ),
      },
    ],
    [],
  );

  const disagreements = disagreementsQuery.data?.disagreements ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Network catalog"
        description="Co-op master SKUs: pack sizes and the retail price ceiling. Location products copy identity from here; stores may price at or below the ceiling."
      />

      {error && (
        <p className="rounded-md border border-state-danger/40 bg-state-danger/10 px-3 py-2 text-sm text-state-danger">
          {error}
        </p>
      )}
      {message && (
        <p className="rounded-md border border-border-hairline bg-surface-raised px-3 py-2 text-sm text-ink">
          {message}
        </p>
      )}

      {disagreements.length > 0 && (
        <Card title="Backfill disagreements">
          <p className="mb-3 text-sm text-ink-muted">
            Locations disagreed on these fields during{" "}
            <code className="font-mono text-xs">npm run db:backfill-catalog</code>. The master
            currently uses the most common value — confirm or edit the catalog row, then Resolve.
          </p>
          <ul className="space-y-2 text-sm">
            {disagreements.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded border border-border-hairline px-3 py-2"
              >
                <div>
                  <span className="font-mono text-xs">{d.sku}</span> · {d.field} → chose{" "}
                  <strong>{d.chosenValue}</strong>
                  <div className="mt-1 text-ink-muted">
                    {d.values.map((v) => (
                      <span key={String(v.value)} className="mr-3">
                        {String(v.value)} ×{v.count}
                      </span>
                    ))}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="quiet"
                  loading={resolveMutation.isPending}
                  onClick={() => resolveMutation.mutate(d.id)}
                >
                  Resolve
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={editing ? `Edit ${editing.sku}` : "Add catalog item"}>
        <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-4">
          {(
            [
              ["sku", "SKU"],
              ["name", "Name"],
              ["category", "Category"],
              ["unitsPerCase", "Units / case"],
              ["casesPerPallet", "Cases / pallet"],
              ["caseWeightKg", "Case weight (kg)"],
              ["caseGtin", "Case GTIN"],
              ["maxShelfPrice", "Max shelf price"],
            ] as const
          ).map(([key, label]) => (
            <Field
              key={key}
              label={label}
              value={form[key]}
              onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
              required={
                key === "sku" ||
                key === "name" ||
                key === "category" ||
                key === "unitsPerCase" ||
                key === "maxShelfPrice"
              }
            />
          ))}
          <label className="flex items-end gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={form.taxExempt}
              onChange={(e) => setForm((f) => ({ ...f, taxExempt: e.target.checked }))}
            />
            Tax exempt
          </label>
          <label className="flex items-end gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
            />
            Active
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
        </form>
      </Card>

      <DataTable
        columns={columns}
        rows={itemsQuery.data?.items ?? []}
        rowKey={(i) => i.id}
        emptyMessage={itemsQuery.isLoading ? "Loading…" : "No catalog items yet."}
      />
    </div>
  );
}
