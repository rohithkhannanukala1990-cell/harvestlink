/**
 * Lots page — search by lot number, filter status/expiry, trace forward, quarantine.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "../api/client";
import type { Lot, LotStatus } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { formatExpiry } from "../lib/lotDisplay";
import {
  Button,
  Card,
  DataTable,
  Field,
  LotStatusBadge,
  PageHeader,
  SelectField,
  isLotBlockedFromSale,
  type DataTableColumn,
} from "../components/ui";

type TraceForward = {
  lotId: string;
  lotNumber: string;
  quantitySold: number;
  quantityRemaining: number;
  members: Array<{
    memberId: string;
    name: string;
    email: string;
    phone: string;
    quantityPurchased: number;
  }>;
  sales: Array<{ saleId: string; quantityFromLot: number }>;
};

const STATUSES: Array<LotStatus | ""> = [
  "",
  "ACTIVE",
  "QUARANTINED",
  "RECALLED",
  "EXPIRED",
  "DEPLETED",
];

export function LotsPage() {
  const { activeStoreId, isRole } = useAuth();
  const canQuarantine = isRole("STORE_ADMIN", "COOP_ADMIN");
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<LotStatus | "">("");
  const [expiryWithinDays, setExpiryWithinDays] = useState<string>("");
  const [traceLotId, setTraceLotId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (activeStoreId) p.set("storeId", activeStoreId);
    if (search.trim()) p.set("q", search.trim());
    if (status) p.set("status", status);
    if (expiryWithinDays) p.set("expiryWithinDays", expiryWithinDays);
    return p.toString();
  }, [activeStoreId, search, status, expiryWithinDays]);

  const lotsQuery = useQuery({
    queryKey: ["lots", params],
    enabled: !!activeStoreId,
    queryFn: () => apiRequest<{ lots: Lot[] }>(`/lots?${params}`),
  });

  const traceQuery = useQuery({
    queryKey: ["trace", "forward", traceLotId],
    enabled: !!traceLotId,
    queryFn: () => apiRequest<TraceForward>(`/traceability/lots/${traceLotId}/forward`),
  });

  const quarantine = useMutation({
    mutationFn: (lot: Lot) => {
      const reason = window.prompt(`Quarantine lot ${lot.lotNumber}. Reason:`, "");
      if (!reason?.trim()) throw new ApiError(400, "Reason required");
      return apiRequest<{ lot: Lot }>(`/lots/${lot.id}/quarantine`, {
        method: "POST",
        body: { reason: reason.trim(), ...(activeStoreId ? { storeId: activeStoreId } : {}) },
      });
    },
    onSuccess: () => {
      setMessage("Lot quarantined — it will not sell at POS");
      void qc.invalidateQueries({ queryKey: ["lots"] });
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["recalls", "active-for-store"] });
    },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : "Quarantine failed"),
  });

  if (!activeStoreId) {
    return <p className="text-ink-muted">Select a store to browse lots.</p>;
  }

  const lots = lotsQuery.data?.lots ?? [];

  const columns: DataTableColumn<Lot>[] = [
    {
      id: "lot",
      header: "Lot #",
      cell: (lot) => <span className="font-mono text-xs">{lot.lotNumber}</span>,
    },
    {
      id: "product",
      header: "Product",
      cell: (lot) => (
        <div>
          <div>{lot.productName}</div>
          <div className="font-mono text-xs text-ink-muted">{lot.sku}</div>
        </div>
      ),
    },
    {
      id: "qty",
      header: "Qty",
      numeric: true,
      cell: (lot) => <span className="tabular">{lot.quantityRemaining}</span>,
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
        <LotStatusBadge
          status={lot.status}
          nearExpiry={
            lot.status === "ACTIVE" &&
            lot.daysUntilExpiry != null &&
            lot.daysUntilExpiry <= 14
          }
        />
      ),
    },
    {
      id: "actions",
      header: "Actions",
      cell: (lot) => {
        const blocked = isLotBlockedFromSale(lot.status);
        return (
          <span className="inline-flex flex-wrap items-center gap-2 whitespace-nowrap">
            <Button type="button" variant="quiet" onClick={() => setTraceLotId(lot.id)}>
              Trace
            </Button>
            {canQuarantine && (
              <Button
                type="button"
                variant="destructive"
                disabled={blocked || lot.status !== "ACTIVE" || quarantine.isPending}
                title={
                  blocked
                    ? "Already quarantined or recalled — not for sale"
                    : "Quarantine lot"
                }
                onClick={() => quarantine.mutate(lot)}
              >
                Quarantine
              </Button>
            )}
            {isRole("COOP_ADMIN") && (
              <Link
                className="text-sm font-semibold text-brand-terracotta-ink underline"
                to="/recalls"
              >
                Recall
              </Link>
            )}
          </span>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Lots"
        description="Search by lot number or product. Trace opens the forward recall list. Quarantine pulls stock from sale immediately."
      />

      {message && (
        <p className="rounded-md border border-border-hairline bg-surface-raised px-3 py-2 text-sm text-ink">
          {message}
        </p>
      )}

      <Card>
        <div className="flex flex-wrap gap-3">
          <Field
            label="Search"
            className="min-w-[14rem]"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Lot #, SKU, name"
          />
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as LotStatus | "")}
          >
            {STATUSES.map((s) => (
              <option key={s || "all"} value={s}>
                {s || "All"}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Expiry within"
            value={expiryWithinDays}
            onChange={(e) => setExpiryWithinDays(e.target.value)}
          >
            <option value="">Any</option>
            <option value="7">7 days</option>
            <option value="14">14 days</option>
            <option value="30">30 days</option>
            <option value="0">Overdue / today</option>
          </SelectField>
        </div>
      </Card>

      <DataTable
        columns={columns}
        rows={lots}
        rowKey={(lot) => lot.id}
        emptyMessage={lotsQuery.isLoading ? "Loading…" : "No lots match."}
      />

      {traceLotId && (
        <Card
          title="Forward trace"
          actions={
            <Button type="button" variant="quiet" onClick={() => setTraceLotId(null)}>
              Close
            </Button>
          }
        >
          {traceQuery.isLoading && <p className="text-sm text-ink-muted">Loading…</p>}
          {traceQuery.data && (
            <div className="space-y-3 text-sm text-ink">
              <p>
                Lot <span className="font-mono">{traceQuery.data.lotNumber}</span> — sold{" "}
                <span className="tabular">{traceQuery.data.quantitySold}</span>, remaining{" "}
                <span className="tabular">{traceQuery.data.quantityRemaining}</span>
              </p>
              <div>
                <h3 className="font-semibold">
                  Affected members (
                  <span className="tabular">{traceQuery.data.members.length}</span>)
                </h3>
                <ul className="mt-1 list-inside list-disc">
                  {traceQuery.data.members.map((m) => (
                    <li key={m.memberId}>
                      {m.name} · {m.email} ·{" "}
                      <span className="tabular">{m.quantityPurchased}</span> unit(s)
                    </li>
                  ))}
                  {traceQuery.data.members.length === 0 && (
                    <li className="list-none text-ink-muted">No member purchases yet.</li>
                  )}
                </ul>
              </div>
              <div>
                <h3 className="font-semibold">
                  Sales (<span className="tabular">{traceQuery.data.sales.length}</span>)
                </h3>
                <ul className="mt-1 list-inside list-disc font-mono text-xs">
                  {traceQuery.data.sales.map((s) => (
                    <li key={s.saleId}>
                      {s.saleId} ×<span className="tabular">{s.quantityFromLot}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {traceQuery.isError && (
            <p className="text-sm text-state-danger" role="alert">
              {(traceQuery.error as Error).message}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
