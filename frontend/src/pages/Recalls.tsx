/**
 * Recall management — COOP_ADMIN initiates / activates / closes product recalls.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiRequest } from "../api/client.ts";
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
  type StatusTone,
} from "../components/ui";

type RecallRow = {
  id: string;
  recallNumber: string;
  reason: string;
  severity: string;
  status: string;
  initiatedAt: string;
  lots: Array<{ id: string; lotId: string; quantityAtRecall: number; lot: { lotNumber: string } }>;
  _count: { notifications: number };
};

type Impact = {
  affectedMembers: Array<{
    memberId: string;
    name: string;
    email: string;
    quantityPurchased: number;
  }>;
  unitsSold: number;
  unitsOnShelves: number;
  storesInvolved: Array<{ storeName: string }>;
  estimatedFinancialExposure: string;
};

function recallStatusBadge(status: string) {
  const tone: StatusTone =
    status === "ACTIVE"
      ? "danger"
      : status === "DRAFT"
        ? "warning"
        : status === "CLOSED"
          ? "neutral"
          : "neutral";
  const label =
    status === "ACTIVE"
      ? "Recalled"
      : status === "DRAFT"
        ? "Pending"
        : status === "CLOSED"
          ? "Closed"
          : status;
  return <StatusBadge label={label} tone={tone} />;
}

export function RecallsPage() {
  const qc = useQueryClient();
  const [lotIdsText, setLotIdsText] = useState("");
  const [reason, setReason] = useState("");
  const [severity, setSeverity] = useState<"ADVISORY" | "VOLUNTARY" | "MANDATORY">("VOLUNTARY");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["recalls"],
    queryFn: () => apiRequest<{ recalls: RecallRow[] }>("/recalls"),
  });

  const impactQuery = useQuery({
    queryKey: ["recalls", selectedId, "impact"],
    queryFn: () => apiRequest<Impact>(`/recalls/${selectedId}/impact`),
    enabled: !!selectedId,
  });

  const initiate = useMutation({
    mutationFn: () =>
      apiRequest<{ recall: RecallRow }>("/recalls", {
        method: "POST",
        body: {
          lotIds: lotIdsText
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter(Boolean),
          reason,
          severity,
        },
      }),
    onSuccess: () => {
      setError(null);
      setLotIdsText("");
      setReason("");
      void qc.invalidateQueries({ queryKey: ["recalls"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const activate = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/recalls/${id}/activate`, { method: "POST", body: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["recalls"] });
      void qc.invalidateQueries({ queryKey: ["recalls", "active-for-store"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const dispatch = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/recalls/${id}/dispatch`, { method: "POST", body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["recalls"] }),
    onError: (e: Error) => setError(e.message),
  });

  const refunds = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/recalls/${id}/refunds`, { method: "POST", body: {} }),
    onError: (e: Error) => setError(e.message),
  });

  const close = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/recalls/${id}/close`, { method: "POST", body: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["recalls"] });
      void qc.invalidateQueries({ queryKey: ["recalls", "active-for-store"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const recalls = listQuery.data?.recalls ?? [];
  const activeRecalls = recalls.filter((r) => r.status === "ACTIVE");

  const columns: DataTableColumn<RecallRow>[] = [
    {
      id: "number",
      header: "Number",
      cell: (r) => <span className="font-semibold">{r.recallNumber}</span>,
    },
    {
      id: "status",
      header: "Status",
      cell: (r) => recallStatusBadge(r.status),
    },
    { id: "severity", header: "Severity", cell: (r) => r.severity },
    {
      id: "lots",
      header: "Lots",
      cell: (r) => r.lots.map((l) => l.lot.lotNumber).join(", "),
    },
    {
      id: "actions",
      header: "Actions",
      cell: (r) => (
        <span className="inline-flex flex-wrap gap-2">
          <Button type="button" variant="quiet" onClick={() => setSelectedId(r.id)}>
            Impact
          </Button>
          {r.status === "DRAFT" && (
            <Button
              type="button"
              variant="destructive"
              loading={activate.isPending}
              onClick={() => activate.mutate(r.id)}
            >
              Activate
            </Button>
          )}
          {r.status === "ACTIVE" && (
            <>
              <Button
                type="button"
                variant="quiet"
                loading={dispatch.isPending}
                onClick={() => dispatch.mutate(r.id)}
              >
                Dispatch notices
              </Button>
              <Button
                type="button"
                variant="destructive"
                loading={refunds.isPending}
                onClick={() => refunds.mutate(r.id)}
              >
                Refund
              </Button>
              <Button
                type="button"
                variant="quiet"
                loading={close.isPending}
                onClick={() => close.mutate(r.id)}
              >
                Close
              </Button>
            </>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recalls"
        description="Quarantine first, investigate second. Recalled goods never return to sellable stock. Records are retained for regulators — never deleted."
      />

      {activeRecalls.length > 0 && (
        <div
          className="rounded-lg border border-state-danger bg-state-danger px-4 py-3 text-ink-inverse"
          role="alert"
        >
          <p className="font-semibold tracking-wide">ACTIVE PRODUCT RECALL</p>
          <ul className="mt-1 space-y-1 text-sm">
            {activeRecalls.map((r) => (
              <li key={r.id}>
                <span className="font-medium">{r.recallNumber}</span>
                {" · "}
                {r.severity} — {r.reason}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-sm opacity-90">
            Affected stores also see this banner on Inventory, Lots, POS, and receiving.
          </p>
        </div>
      )}

      {error && (
        <div
          className="rounded-md border border-state-danger bg-state-danger/10 px-3 py-2 text-sm text-state-danger"
          role="alert"
        >
          {error}
        </div>
      )}

      <Card title="Initiate recall">
        <p className="mb-4 text-sm text-ink-muted">
          Lots are quarantined immediately so POS cannot sell another unit during setup.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm sm:col-span-2">
            <span className="font-semibold text-ink">Lot IDs</span>
            <textarea
              className="w-full rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm text-ink"
              rows={2}
              value={lotIdsText}
              onChange={(e) => setLotIdsText(e.target.value)}
              placeholder="cuid lot ids, comma or space separated"
            />
          </label>
          <Field
            label="Reason"
            className="sm:col-span-2"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <SelectField
            label="Severity"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as typeof severity)}
          >
            <option value="ADVISORY">ADVISORY</option>
            <option value="VOLUNTARY">VOLUNTARY</option>
            <option value="MANDATORY">MANDATORY</option>
          </SelectField>
        </div>
        <div className="mt-4">
          <Button
            type="button"
            variant="destructive"
            disabled={!lotIdsText.trim() || !reason.trim()}
            loading={initiate.isPending}
            onClick={() => initiate.mutate()}
          >
            Quarantine & create DRAFT
          </Button>
        </div>
      </Card>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-ink">Open recalls</h2>
        <DataTable
          columns={columns}
          rows={recalls}
          rowKey={(r) => r.id}
          emptyMessage="No recalls yet."
        />
      </section>

      {selectedId && impactQuery.data && (
        <Card title="Impact preview">
          <p className="text-sm text-ink">
            Sold <span className="tabular">{impactQuery.data.unitsSold}</span> · On shelves{" "}
            <span className="tabular">{impactQuery.data.unitsOnShelves}</span> · Exposure{" "}
            <Money value={impactQuery.data.estimatedFinancialExposure} tone="alert" /> · Stores{" "}
            {impactQuery.data.storesInvolved.map((s) => s.storeName).join(", ") || "—"}
          </p>
          <ul className="mt-3 list-inside list-disc text-sm text-ink">
            {impactQuery.data.affectedMembers.map((m) => (
              <li key={m.memberId}>
                {m.name} ({m.email}) —{" "}
                <span className="tabular">{m.quantityPurchased}</span> unit(s)
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
