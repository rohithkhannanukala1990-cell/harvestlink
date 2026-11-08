/**
 * Import shipment detail — timeline, POs, lines, costs (Est vs Final + superseded),
 * allocation preview, documents, compliance warnings, true-up.
 * Holds / compliance use terracotta — never gold.
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "../api/client";
import type {
  AllocationPreview,
  ImportShipment,
  ShipmentDocumentRow,
  TrueUpPreview,
} from "../api/types";
import {
  Button,
  Card,
  DataTable,
  Money,
  PageHeader,
  StatCard,
  StatusBadge,
  UnitCost,
  formatMoney,
  type DataTableColumn,
} from "../components/ui";
import { shipmentStatusBadge } from "./Shipments";

function num(v: string | number | null | undefined): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function ShipmentDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [trueUpPreview, setTrueUpPreview] = useState<TrueUpPreview | null>(null);

  const shipmentQuery = useQuery({
    queryKey: ["shipment", id],
    enabled: !!id,
    queryFn: () => apiRequest<ImportShipment>(`/shipments/${id}`),
  });

  const allocationQuery = useQuery({
    queryKey: ["shipment", id, "allocation"],
    enabled: !!id,
    queryFn: () => apiRequest<AllocationPreview>(`/shipments/${id}/allocation-preview`),
    retry: false,
  });

  const docsQuery = useQuery({
    queryKey: ["shipment", id, "documents"],
    enabled: !!id,
    queryFn: () =>
      apiRequest<{ documents: ShipmentDocumentRow[] }>(
        `/compliance/shipments/${id}/documents`,
      ),
  });

  const shipment = shipmentQuery.data;
  const costs = shipment?.costs ?? [];
  const supersededIds = useMemo(
    () => new Set(costs.filter((c) => c.supersedesCostId).map((c) => c.supersedesCostId!)),
    [costs],
  );

  const complianceWarnings = useMemo(() => {
    const warnings: string[] = [];
    if (shipment?.status === "CUSTOMS_HOLD" && shipment.holdReason) {
      warnings.push(`Customs hold: ${shipment.holdReason}`);
    }
    const docs = docsQuery.data?.documents ?? [];
    if (!docs.some((d) => d.docType === "FDA_PRIOR_NOTICE")) {
      warnings.push("Missing FDA prior notice document");
    }
    return warnings;
  }, [shipment, docsQuery.data]);

  const previewTrueUp = useMutation({
    mutationFn: () => apiRequest<TrueUpPreview>(`/shipments/${id}/true-up-preview`),
    onSuccess: (data) => {
      setTrueUpPreview(data);
      setMessage(
        data.hasChanges
          ? `True-up preview: ${formatMoney(data.totalVarianceUsd)} variance across ${data.lots.length} lots`
          : "True-up preview: no cost changes to apply",
      );
    },
    onError: (err) =>
      setMessage(err instanceof ApiError ? err.message : "True-up preview failed"),
  });

  const runTrueUp = useMutation({
    mutationFn: () => apiRequest<TrueUpPreview>(`/shipments/${id}/true-up`, { method: "POST" }),
    onSuccess: (data) => {
      setTrueUpPreview(data);
      setMessage(
        data.wroteChanges
          ? `True-up applied${data.movedToCosted ? " · moved to COSTED" : ""}`
          : "True-up ran with no writes",
      );
      void qc.invalidateQueries({ queryKey: ["shipment", id] });
    },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : "True-up failed"),
  });

  if (!shipment) {
    return <p className="text-ink-muted">Loading shipment…</p>;
  }

  const lineColumns: DataTableColumn<NonNullable<ImportShipment["lines"]>[number]>[] = [
    {
      id: "sku",
      header: "Product",
      cell: (l) => (
        <span>
          <span className="font-mono text-xs">{l.poLine?.product?.sku}</span>
          <span className="text-ink-muted"> · {l.poLine?.product?.name}</span>
        </span>
      ),
    },
    {
      id: "qty",
      header: "Qty",
      numeric: true,
      cell: (l) => <span className="tabular">{l.quantity}</span>,
    },
    {
      id: "wt",
      header: "Weight kg",
      numeric: true,
      cell: (l) => (
        <span className="tabular">{l.grossWeightKg != null ? num(l.grossWeightKg).toFixed(1) : "—"}</span>
      ),
    },
    {
      id: "vol",
      header: "CBM",
      numeric: true,
      cell: (l) => (
        <span className="tabular">{l.volumeCbm != null ? num(l.volumeCbm).toFixed(3) : "—"}</span>
      ),
    },
    {
      id: "hts",
      header: "HTS",
      cell: (l) => <span className="font-mono text-xs">{l.htsCode ?? "—"}</span>,
    },
    {
      id: "duty",
      header: "Duty",
      numeric: true,
      cell: (l) =>
        l.dutyAmountUsd != null ? (
          <Money value={l.dutyAmountUsd} />
        ) : l.dutyRatePercent != null ? (
          <span className="tabular">{num(l.dutyRatePercent).toFixed(1)}%</span>
        ) : (
          "—"
        ),
    },
  ];

  const allocColumns: DataTableColumn<AllocationPreview["lines"][number]>[] = [
    {
      id: "product",
      header: "Product",
      cell: (l) => (
        <span>
          <span className="font-mono text-xs">{l.sku}</span>
          <span className="text-ink-muted"> · {l.name}</span>
        </span>
      ),
    },
    {
      id: "qty",
      header: "Qty",
      numeric: true,
      cell: (l) => <span className="tabular">{l.quantity}</span>,
    },
    {
      id: "invoice",
      header: "Invoice / customs",
      numeric: true,
      cell: (l) => <Money value={num(l.customsValueUsd) / Math.max(1, l.quantity)} />,
    },
    {
      id: "addon",
      header: "Landed add-on",
      numeric: true,
      cell: (l) => <UnitCost value={l.landedAddOnPerUnit} />,
    },
    {
      id: "landed",
      header: "Landed cost",
      numeric: true,
      cell: (l) => <UnitCost value={l.landedUnitCost} />,
    },
    {
      id: "uplift",
      header: "Uplift",
      numeric: true,
      cell: (l) => <span className="tabular">{num(l.upliftPercent).toFixed(1)}%</span>,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={shipment.shipmentNumber}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Link to="/shipments" className="text-brand-terracotta-ink underline">
              ← Shipments
            </Link>
            <span className="text-ink-muted">
              · {shipment.mode.replace("_", " ")} · {shipment.incoterm}
              {shipment.containerNumber ? ` · ${shipment.containerNumber}` : ""}
            </span>
          </span>
        }
        actions={shipmentStatusBadge(shipment.status, shipment.holdReason)}
      />

      {message && (
        <p className="rounded-lg bg-surface-sunken px-3 py-2 text-sm text-ink">{message}</p>
      )}

      {complianceWarnings.length > 0 && (
        <div
          className="rounded-lg border border-brand-terracotta/40 bg-brand-terracotta/10 px-4 py-3 text-sm text-brand-terracotta-ink"
          role="status"
        >
          <p className="font-semibold">Compliance warnings</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {complianceWarnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-4">
        <StatCard label="Goods value" value={formatMoney(shipment.goodsValueUsd)} />
        <StatCard label="Landed costs" value={formatMoney(shipment.landedCostsUsd)} />
        <StatCard label="Landed total" value={formatMoney(shipment.landedTotalUsd)} />
        <StatCard
          label="Uplift"
          value={`${num(shipment.upliftPercent).toFixed(1)}%`}
          tone={shipment.status === "CUSTOMS_HOLD" ? "terracotta" : "default"}
        />
      </div>

      <Card title="Timeline">
        <ol className="space-y-2 border-l-2 border-border-hairline pl-4">
          {(shipment.events ?? []).length === 0 && (
            <li className="text-sm text-ink-muted">No events yet.</li>
          )}
          {(shipment.events ?? []).map((e) => (
            <li key={e.id} className="relative text-sm">
              <span className="absolute -left-[1.35rem] top-1.5 h-2 w-2 rounded-full bg-brand-green" />
              <span className="tabular text-ink-muted">
                {new Date(e.createdAt).toISOString().replace("T", " ").slice(0, 16)}Z
              </span>
              <span className="ml-2 font-semibold text-ink">{e.eventType}</span>
              {e.message ? <span className="text-ink-muted"> — {e.message}</span> : null}
            </li>
          ))}
        </ol>
      </Card>

      <Card title="Purchase orders">
        <ul className="space-y-2 text-sm">
          {(shipment.purchaseOrders ?? []).map((link) => (
            <li
              key={link.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-border-hairline pb-2"
            >
              <Link
                to={`/purchase-orders/${link.poId}`}
                className="font-mono font-semibold text-ink underline decoration-brand-terracotta-ink/40"
              >
                {link.po.poNumber}
              </Link>
              <span className="text-ink-muted">
                {link.po.supplier?.name}
                {link.po.supplier?.supplierType
                  ? ` · ${link.po.supplier.supplierType}`
                  : ""}
              </span>
              <Money value={link.po.total} />
            </li>
          ))}
          {(shipment.purchaseOrders ?? []).length === 0 && (
            <li className="text-ink-muted">No POs attached.</li>
          )}
        </ul>
      </Card>

      <Card title="Lines">
        <DataTable
          columns={lineColumns}
          rows={shipment.lines ?? []}
          rowKey={(l) => l.id}
          emptyMessage="No shipment lines yet"
        />
      </Card>

      <Card title="Costs — Estimated vs Final">
        <ul className="space-y-2 text-sm">
          {costs.map((c) => {
            const superseded = supersededIds.has(c.id);
            return (
              <li
                key={c.id}
                className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 ${
                  superseded
                    ? "border-border-hairline bg-surface-sunken text-ink-muted line-through"
                    : "border-border-hairline bg-surface-raised"
                }`}
              >
                <span className="font-medium">
                  {c.costType.replace(/_/g, " ")}
                  {c.vendorName ? ` · ${c.vendorName}` : ""}
                </span>
                <span className="flex items-center gap-2">
                  {superseded ? (
                    <StatusBadge label="Superseded" tone="neutral" />
                  ) : c.status === "FINAL" ? (
                    <StatusBadge label="Final" tone="success" />
                  ) : (
                    <StatusBadge label="Estimated" tone="terracotta" />
                  )}
                  <Money value={c.amountUsd} />
                </span>
              </li>
            );
          })}
          {costs.length === 0 && (
            <li className="text-ink-muted">No costs recorded yet.</li>
          )}
        </ul>
      </Card>

      <Card title="Allocation preview">
        {allocationQuery.isError ? (
          <p className="text-sm text-ink-muted">
            {allocationQuery.error instanceof ApiError
              ? allocationQuery.error.message
              : "Allocation preview unavailable"}
          </p>
        ) : (
          <DataTable
            columns={allocColumns}
            rows={allocationQuery.data?.lines ?? []}
            rowKey={(l) => l.shipmentLineId}
            emptyMessage="No allocation lines"
          />
        )}
      </Card>

      <Card title="Documents">
        <ul className="space-y-2 text-sm">
          {(docsQuery.data?.documents ?? []).map((d) => (
            <li
              key={d.id}
              className="flex flex-wrap justify-between gap-2 border-b border-border-hairline pb-2"
            >
              <span className="font-medium text-ink">
                {d.docType.replace(/_/g, " ")}
                {d.referenceNumber ? (
                  <span className="ml-2 font-mono text-xs text-ink-muted">
                    ref {d.referenceNumber}
                  </span>
                ) : null}
              </span>
              <span className="text-ink-muted">{d.document?.fileName ?? d.documentId}</span>
            </li>
          ))}
          {(docsQuery.data?.documents ?? []).length === 0 && (
            <li className="text-ink-muted">No documents attached.</li>
          )}
        </ul>
      </Card>

      <Card title="Landed-cost true-up">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="quiet"
            loading={previewTrueUp.isPending}
            onClick={() => previewTrueUp.mutate()}
          >
            Preview true-up
          </Button>
          <Button
            type="button"
            loading={runTrueUp.isPending}
            disabled={!trueUpPreview?.hasChanges && !trueUpPreview?.allCostsFinal}
            onClick={() => runTrueUp.mutate()}
          >
            Run true-up
          </Button>
        </div>
        {trueUpPreview && (
          <div className="mt-4 space-y-2 text-sm">
            <p className="text-ink">
              Variance <Money value={trueUpPreview.totalVarianceUsd} /> ·{" "}
              {trueUpPreview.allCostsFinal ? "all costs final" : "estimates still open"} ·{" "}
              {trueUpPreview.lots.length} lots
            </p>
            {trueUpPreview.lots.slice(0, 8).map((lot) => (
              <div
                key={lot.lotId}
                className="flex flex-wrap justify-between gap-2 border-b border-border-hairline pb-1 text-ink-muted"
              >
                <span className="font-mono text-xs">{lot.lotId.slice(0, 8)}…</span>
                <span>
                  add-on <UnitCost value={lot.previousAddOn} /> →{" "}
                  <UnitCost value={lot.newAddOn} /> · Δ{" "}
                  <Money value={lot.varianceAmountUsd} />
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
