/**
 * Suppliers list + detail (link preferred products / costs).
 * FPO profile + certifications with terracotta expiry badges (never gold).
 */
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "../api/client";
import type {
  CertificationType,
  FpoLegalForm,
  FpoProfile,
  Product,
  Supplier,
  SupplierCertification,
  SupplierType,
} from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { storeQuery } from "../auth/storeQuery";
import {
  Button,
  Card,
  DataTable,
  Field,
  PageHeader,
  SelectField,
  StatusBadge,
  UnitCost,
  type DataTableColumn,
} from "../components/ui";

const SUPPLIER_TYPES: SupplierType[] = [
  "FPO",
  "EXPORTER",
  "DOMESTIC_DISTRIBUTOR",
  "DOMESTIC_VENDOR",
  "OTHER",
];

const LEGAL_FORMS: FpoLegalForm[] = ["PRODUCER_COMPANY", "COOPERATIVE_SOCIETY", "OTHER"];

const CERT_TYPES: CertificationType[] = [
  "FSSAI_LICENSE",
  "APEDA_RCMC",
  "FDA_FOOD_FACILITY_REGISTRATION",
  "ORGANIC_NPOP",
  "ORGANIC_USDA",
  "FSVP_VERIFICATION",
  "LAB_ACCREDITATION",
  "OTHER",
];

function certExpiryBadge(cert: SupplierCertification) {
  const now = Date.now();
  const expires = cert.expiresAt ? new Date(cert.expiresAt).getTime() : null;
  const review = cert.nextReviewDue ? new Date(cert.nextReviewDue).getTime() : null;
  if (expires != null && expires < now) {
    return <StatusBadge label="Expired" tone="danger" />;
  }
  if (review != null && review < now) {
    return <StatusBadge label="Review due" tone="terracotta" />;
  }
  const soon = now + 30 * 86_400_000;
  if (expires != null && expires <= soon) {
    return <StatusBadge label="Expiring soon" tone="terracotta" />;
  }
  if (review != null && review <= soon) {
    return <StatusBadge label="Review due" tone="terracotta" />;
  }
  return <StatusBadge label="Active" tone="success" />;
}

export function SuppliersPage() {
  const { id } = useParams();
  if (id) return <SupplierDetail id={id} />;
  return <SupplierList />;
}

function SupplierList() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [supplierType, setSupplierType] = useState<SupplierType>("OTHER");
  const [country, setCountry] = useState("US");
  const [error, setError] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["suppliers"],
    queryFn: () => apiRequest<{ suppliers: Supplier[] }>("/purchasing/suppliers"),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      apiRequest<{ supplier: Supplier }>("/purchasing/suppliers", {
        method: "POST",
        body: { name, supplierType, country },
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
    {
      id: "type",
      header: "Type",
      cell: (s) => s.supplierType?.replace(/_/g, " ") ?? "—",
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
          <SelectField
            label="Type"
            value={supplierType}
            onChange={(e) => setSupplierType(e.target.value as SupplierType)}
          >
            {SUPPLIER_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </SelectField>
          <Field
            label="Country"
            className="w-24"
            value={country}
            maxLength={2}
            onChange={(e) => setCountry(e.target.value.toUpperCase())}
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
  const { activeStoreId, isRole } = useAuth();
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
    supplierType: "OTHER" as SupplierType,
    country: "US",
  });
  const [fpoForm, setFpoForm] = useState({
    legalForm: "OTHER" as FpoLegalForm,
    registrationNumber: "",
    state: "",
    district: "",
    memberFarmerCount: "",
    memberFarmerCountAsOf: "",
    primaryCrops: "",
    notes: "",
  });
  const [certForm, setCertForm] = useState({
    certType: "FSVP_VERIFICATION" as CertificationType,
    certNumber: "",
    issuedAt: "",
    expiresAt: "",
    nextReviewDue: "",
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
        supplierType: data.supplier.supplierType ?? "OTHER",
        country: data.supplier.country ?? "US",
      });
      return data;
    },
  });

  const fpoQuery = useQuery({
    queryKey: ["supplier", id, "fpo-profile"],
    enabled: !!id && isRole("COOP_ADMIN") && form.supplierType === "FPO",
    queryFn: async () => {
      try {
        const data = await apiRequest<{ profile: FpoProfile }>(
          `/purchasing/suppliers/${id}/fpo-profile`,
        );
        const p = data.profile;
        setFpoForm({
          legalForm: p.legalForm,
          registrationNumber: p.registrationNumber,
          state: p.state,
          district: p.district,
          memberFarmerCount: String(p.memberFarmerCount),
          memberFarmerCountAsOf: p.memberFarmerCountAsOf.slice(0, 10),
          primaryCrops: p.primaryCrops.join(", "),
          notes: p.notes,
        });
        return data;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return { profile: null };
        throw err;
      }
    },
  });

  const certsQuery = useQuery({
    queryKey: ["supplier", id, "certifications"],
    enabled: !!id,
    queryFn: () =>
      apiRequest<{ certifications: SupplierCertification[] }>(
        `/compliance/suppliers/${id}/certifications`,
      ),
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

  const saveFpoMutation = useMutation({
    mutationFn: () =>
      apiRequest<{ profile: FpoProfile }>(`/purchasing/suppliers/${id}/fpo-profile`, {
        method: "PUT",
        body: {
          supplierId: id,
          legalForm: fpoForm.legalForm,
          registrationNumber: fpoForm.registrationNumber,
          state: fpoForm.state,
          district: fpoForm.district,
          memberFarmerCount: Number(fpoForm.memberFarmerCount) || 0,
          memberFarmerCountAsOf: fpoForm.memberFarmerCountAsOf
            ? `${fpoForm.memberFarmerCountAsOf}T00:00:00.000Z`
            : undefined,
          primaryCrops: fpoForm.primaryCrops
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean),
          notes: fpoForm.notes,
        },
      }),
    onSuccess: () => {
      setMessage("FPO profile saved");
      void qc.invalidateQueries({ queryKey: ["supplier", id, "fpo-profile"] });
    },
    onError: (err) =>
      setMessage(err instanceof ApiError ? err.message : "FPO profile save failed"),
  });

  const addCertMutation = useMutation({
    mutationFn: () =>
      apiRequest("/compliance/certifications", {
        method: "POST",
        body: {
          supplierId: id,
          certType: certForm.certType,
          certNumber: certForm.certNumber || undefined,
          issuedAt: certForm.issuedAt,
          expiresAt: certForm.expiresAt || null,
          nextReviewDue: certForm.nextReviewDue || null,
        },
      }),
    onSuccess: () => {
      setMessage("Certification added");
      setCertForm((f) => ({ ...f, certNumber: "", expiresAt: "", nextReviewDue: "" }));
      void qc.invalidateQueries({ queryKey: ["supplier", id, "certifications"] });
    },
    onError: (err) =>
      setMessage(err instanceof ApiError ? err.message : "Certification save failed"),
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
  const isFpo = form.supplierType === "FPO";

  return (
    <div className="space-y-6">
      <PageHeader
        title={supplier?.name ?? "…"}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Link to="/suppliers" className="text-brand-terracotta-ink underline">
              ← Suppliers
            </Link>
            {supplier?.supplierType && (
              <span className="text-ink-muted">
                · {supplier.supplierType.replace(/_/g, " ")}
                {supplier.country ? ` · ${supplier.country}` : ""}
              </span>
            )}
          </span>
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
          <SelectField
            label="Type"
            value={form.supplierType}
            onChange={(e) =>
              setForm((f) => ({ ...f, supplierType: e.target.value as SupplierType }))
            }
          >
            {SUPPLIER_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </SelectField>
          <Field
            label="Country"
            value={form.country}
            maxLength={2}
            onChange={(e) =>
              setForm((f) => ({ ...f, country: e.target.value.toUpperCase() }))
            }
          />
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

      {isFpo && isRole("COOP_ADMIN") && (
        <Card title="FPO profile">
          {fpoQuery.isLoading ? (
            <p className="text-sm text-ink-muted">Loading profile…</p>
          ) : (
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                saveFpoMutation.mutate();
              }}
            >
              <SelectField
                label="Legal form"
                value={fpoForm.legalForm}
                onChange={(e) =>
                  setFpoForm((f) => ({
                    ...f,
                    legalForm: e.target.value as FpoLegalForm,
                  }))
                }
              >
                {LEGAL_FORMS.map((f) => (
                  <option key={f} value={f}>
                    {f.replace(/_/g, " ")}
                  </option>
                ))}
              </SelectField>
              <Field
                label="Registration #"
                value={fpoForm.registrationNumber}
                onChange={(e) =>
                  setFpoForm((f) => ({ ...f, registrationNumber: e.target.value }))
                }
              />
              <Field
                label="State"
                value={fpoForm.state}
                onChange={(e) => setFpoForm((f) => ({ ...f, state: e.target.value }))}
              />
              <Field
                label="District"
                value={fpoForm.district}
                onChange={(e) => setFpoForm((f) => ({ ...f, district: e.target.value }))}
              />
              <Field
                label="Member farmer count"
                value={fpoForm.memberFarmerCount}
                onChange={(e) =>
                  setFpoForm((f) => ({ ...f, memberFarmerCount: e.target.value }))
                }
              />
              <Field
                label="Farmer count as of"
                type="date"
                value={fpoForm.memberFarmerCountAsOf}
                onChange={(e) =>
                  setFpoForm((f) => ({ ...f, memberFarmerCountAsOf: e.target.value }))
                }
              />
              <Field
                label="Primary crops"
                hint="Comma-separated"
                className="sm:col-span-2"
                value={fpoForm.primaryCrops}
                onChange={(e) =>
                  setFpoForm((f) => ({ ...f, primaryCrops: e.target.value }))
                }
              />
              {fpoQuery.data?.profile && (
                <p className="sm:col-span-2 text-sm text-ink-muted">
                  Current count{" "}
                  <span className="tabular font-semibold text-ink">
                    {fpoQuery.data.profile.memberFarmerCount}
                  </span>{" "}
                  as of{" "}
                  {new Date(fpoQuery.data.profile.memberFarmerCountAsOf)
                    .toISOString()
                    .slice(0, 10)}
                </p>
              )}
              <div className="sm:col-span-2">
                <Button type="submit" loading={saveFpoMutation.isPending}>
                  Save FPO profile
                </Button>
              </div>
            </form>
          )}
        </Card>
      )}

      <Card title="Certifications">
        <ul className="mb-4 space-y-2 text-sm">
          {(certsQuery.data?.certifications ?? []).map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-border-hairline pb-2"
            >
              <span>
                <span className="font-medium text-ink">
                  {c.certType.replace(/_/g, " ")}
                </span>
                {c.certNumber ? (
                  <span className="ml-2 font-mono text-xs text-ink-muted">
                    {c.certNumber}
                  </span>
                ) : null}
                {c.expiresAt && (
                  <span className="ml-2 text-ink-muted">
                    exp {c.expiresAt.slice(0, 10)}
                  </span>
                )}
              </span>
              {certExpiryBadge(c)}
            </li>
          ))}
          {(certsQuery.data?.certifications ?? []).length === 0 && (
            <li className="text-ink-muted">No certifications on file.</li>
          )}
        </ul>
        {isRole("COOP_ADMIN") && (
          <div className="grid gap-2 border-t border-border-hairline pt-3 sm:grid-cols-3">
            <SelectField
              label="Type"
              value={certForm.certType}
              onChange={(e) =>
                setCertForm((f) => ({
                  ...f,
                  certType: e.target.value as CertificationType,
                }))
              }
            >
              {CERT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, " ")}
                </option>
              ))}
            </SelectField>
            <Field
              label="Number"
              value={certForm.certNumber}
              onChange={(e) => setCertForm((f) => ({ ...f, certNumber: e.target.value }))}
            />
            <Field
              label="Issued"
              type="date"
              value={certForm.issuedAt}
              onChange={(e) => setCertForm((f) => ({ ...f, issuedAt: e.target.value }))}
            />
            <Field
              label="Expires"
              type="date"
              value={certForm.expiresAt}
              onChange={(e) => setCertForm((f) => ({ ...f, expiresAt: e.target.value }))}
            />
            <Field
              label="Next review"
              type="date"
              value={certForm.nextReviewDue}
              onChange={(e) =>
                setCertForm((f) => ({ ...f, nextReviewDue: e.target.value }))
              }
            />
            <div className="flex items-end">
              <Button
                type="button"
                disabled={!certForm.issuedAt}
                loading={addCertMutation.isPending}
                onClick={() => addCertMutation.mutate()}
              >
                Add certification
              </Button>
            </div>
          </div>
        )}
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
                unit <UnitCost value={p.unitCost} /> · case{" "}
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
