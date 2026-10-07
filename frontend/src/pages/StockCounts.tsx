/**
 * Stock counts for the active store — pick one to count.
 *
 * APIs:
 * - GET /stock-counts?storeId — list rows carry no quantities, so this is safe for counters.
 *
 * Counts are created, started and approved by store admins elsewhere; this page is the way in to
 * the scan-first counting screen for anyone on the floor.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiRequest } from "../api/client";
import type { StockCountSummary } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { storeQuery } from "../auth/storeQuery";
import { useOnlineStatus } from "../offline/useOnlineStatus";
import { DataTable, PageHeader, StatusBadge, type DataTableColumn } from "../components/ui";

const STATUS_TONE: Record<StockCountSummary["status"], "neutral" | "warning" | "success" | "gold"> = {
  DRAFT: "neutral",
  IN_PROGRESS: "warning",
  COMPLETED: "success",
  CANCELLED: "neutral",
};

function when(date: string | null): string {
  return date ? new Date(date).toLocaleString() : "—";
}

export function StockCountsPage() {
  const { activeStoreId } = useAuth();
  const online = useOnlineStatus();

  const countsQuery = useQuery({
    queryKey: ["stock-counts", activeStoreId],
    enabled: !!activeStoreId && online,
    queryFn: () => apiRequest<{ counts: StockCountSummary[] }>(`/stock-counts?${storeQuery(activeStoreId)}`),
  });

  if (!activeStoreId) {
    return <p className="text-ink-muted">Select a store.</p>;
  }

  const counts = countsQuery.data?.counts ?? [];
  const inProgress = counts.filter((c) => c.status === "IN_PROGRESS");

  const columns: DataTableColumn<StockCountSummary>[] = [
    {
      id: "type",
      header: "Count",
      cell: (c) => (
        <span>
          <span className="font-semibold text-ink">{c.type}</span>
          {c.scheduledBySystem && <span className="ml-2 text-xs text-ink-muted">scheduled</span>}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (c) => <StatusBadge label={c.status.replace("_", " ")} tone={STATUS_TONE[c.status]} />,
    },
    { id: "lines", header: "Lots", numeric: true, cell: (c) => <span className="tabular">{c.lineCount}</span> },
    { id: "started", header: "Started", cell: (c) => <span className="text-ink-muted">{when(c.startedAt)}</span> },
    { id: "completed", header: "Completed", cell: (c) => <span className="text-ink-muted">{when(c.completedAt)}</span> },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock counts"
        description="Open a count in progress to scan and count. Expected quantities are never shown while counting."
      />

      {!online && (
        <p className="rounded-lg bg-state-warning/15 px-3 py-2 text-sm text-state-warning">
          Offline. Counts opened on this device before still work — go to them from the counting screen
          you had open, or reconnect to see the list.
        </p>
      )}

      {inProgress.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {inProgress.map((c) => (
            <Link
              key={c.id}
              to={`/counts/${c.id}`}
              className="flex min-h-20 flex-col justify-center rounded-lg border-2 border-brand-green bg-surface-raised px-5 py-4"
            >
              <span className="text-xl font-bold text-ink">Count now · {c.type}</span>
              <span className="text-sm text-ink-muted">
                <span className="tabular">{c.lineCount}</span> lots · started {when(c.startedAt)}
              </span>
            </Link>
          ))}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={counts}
        rowKey={(c) => c.id}
        emptyMessage={countsQuery.isLoading ? "Loading counts…" : "No stock counts yet."}
      />
    </div>
  );
}
