/**
 * Import shipments list — COOP_ADMIN. StatCards: value on water, at port/hold, 90-day avg uplift.
 * Holds use terracotta — never gold (member ownership).
 */
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../api/client";
import type { ImportShipment, ImportShipmentStatus } from "../api/types";
import {
  DataTable,
  Money,
  PageHeader,
  StatCard,
  StatusBadge,
  formatMoney,
  type DataTableColumn,
  type StatusTone,
} from "../components/ui";

const ON_THE_WATER: ImportShipmentStatus[] = [
  "BOOKED",
  "IN_TRANSIT",
  "AT_PORT",
  "CUSTOMS_HOLD",
  "CLEARED",
  "DELIVERED",
];

const AT_PORT_OR_HOLD: ImportShipmentStatus[] = ["AT_PORT", "CUSTOMS_HOLD"];

export function shipmentStatusBadge(status: ImportShipmentStatus, holdReason?: string | null) {
  const map: Record<ImportShipmentStatus, { label: string; tone: StatusTone }> = {
    PLANNED: { label: "Pending", tone: "warning" },
    BOOKED: { label: "Confirmed", tone: "success" },
    IN_TRANSIT: { label: "In transit", tone: "success" },
    AT_PORT: { label: "At port", tone: "terracotta" },
    CUSTOMS_HOLD: { label: "On hold", tone: "terracotta" },
    CLEARED: { label: "Cleared", tone: "success" },
    DELIVERED: { label: "Delivered", tone: "success" },
    RECEIVED: { label: "Received", tone: "success" },
    COSTED: { label: "Costed", tone: "success" },
    CLOSED: { label: "Closed", tone: "neutral" },
    CANCELLED: { label: "Cancelled", tone: "neutral" },
  };
  const entry = map[status];
  const label =
    status === "CUSTOMS_HOLD" && holdReason
      ? `On hold · ${holdReason}`
      : entry.label;
  return <StatusBadge label={label} tone={entry.tone} />;
}

function num(v: string | number | null | undefined): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function daysAgo(iso: string | null | undefined, days: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= Date.now() - days * 86_400_000;
}

export function ShipmentsPage() {
  const listQuery = useQuery({
    queryKey: ["shipments"],
    queryFn: () =>
      apiRequest<{ shipments: ImportShipment[]; valueOnTheWater: string | number }>(
        "/shipments",
      ),
  });

  const shipments = listQuery.data?.shipments ?? [];
  const valueOnWater = num(listQuery.data?.valueOnTheWater);

  const atPortHoldValue = shipments
    .filter((s) => AT_PORT_OR_HOLD.includes(s.status))
    .reduce((sum, s) => sum + num(s.goodsValueUsd), 0);

  const upliftWindow = shipments.filter(
    (s) =>
      !["CANCELLED", "PLANNED"].includes(s.status) &&
      num(s.landedCostsUsd) > 0 &&
      (daysAgo(s.actualArrival, 90) ||
        daysAgo(s.deliveredAt, 90) ||
        daysAgo(s.createdAt, 90)),
  );
  const avgUplift =
    upliftWindow.length > 0
      ? upliftWindow.reduce((sum, s) => sum + num(s.upliftPercent), 0) / upliftWindow.length
      : null;

  const columns: DataTableColumn<ImportShipment>[] = [
    {
      id: "number",
      header: "Shipment",
      cell: (s) => (
        <Link
          to={`/shipments/${s.id}`}
          className="font-mono text-xs font-semibold text-ink underline decoration-brand-terracotta-ink/40"
        >
          {s.shipmentNumber}
        </Link>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (s) => shipmentStatusBadge(s.status, s.holdReason),
    },
    {
      id: "eta",
      header: "ETA",
      cell: (s) =>
        s.eta ? (
          <span className="tabular text-sm">
            {new Date(s.eta).toISOString().slice(0, 10)}
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      id: "container",
      header: "Container",
      cell: (s) => (
        <span className="font-mono text-xs">{s.containerNumber ?? "—"}</span>
      ),
    },
    {
      id: "goods",
      header: "Goods value",
      numeric: true,
      cell: (s) => <Money value={s.goodsValueUsd} />,
    },
    {
      id: "uplift",
      header: "Landed uplift",
      numeric: true,
      cell: (s) => (
        <span className="tabular">
          {num(s.goodsValueUsd) > 0 ? `${num(s.upliftPercent).toFixed(1)}%` : "—"}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Shipments"
        description="Import containers — landed cost, customs, and true-up."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Value on the water"
          value={formatMoney(valueOnWater)}
          subLine={`${shipments.filter((s) => ON_THE_WATER.includes(s.status)).length} active`}
        />
        <StatCard
          label="At port / on hold"
          value={formatMoney(atPortHoldValue)}
          tone="terracotta"
          subLine={
            shipments.some((s) => s.status === "CUSTOMS_HOLD")
              ? "Includes customs holds"
              : "Cleared when customs releases"
          }
        />
        <StatCard
          label="Average uplift (90 days)"
          value={avgUplift == null ? "—" : `${avgUplift.toFixed(1)}%`}
          subLine={
            avgUplift == null
              ? "No costed shipments in window"
              : `${upliftWindow.length} shipment${upliftWindow.length === 1 ? "" : "s"}`
          }
        />
      </div>

      <DataTable
        columns={columns}
        rows={shipments}
        rowKey={(s) => s.id}
        emptyMessage="No import shipments yet"
      />
    </div>
  );
}
