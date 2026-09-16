/**
 * Audit log viewer — COOP_ADMIN only.
 * GET /audit with filters for store, user, action, and date range.
 * Read-only: the backend has no update/delete audit endpoints.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../api/client";
import type { AuditLogEntry, Store } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import {
  Button,
  Card,
  DataTable,
  Field,
  PageHeader,
  SelectField,
  type DataTableColumn,
} from "../components/ui";

type AuditResponse = {
  logs: AuditLogEntry[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  actions: string[];
};

function formatJson(value: unknown): string {
  if (value == null) return "—";
  try {
    return JSON.stringify(value, null, 0);
  } catch {
    return String(value);
  }
}

export function AuditPage() {
  const { activeStoreId } = useAuth();
  const [storeId, setStoreId] = useState(activeStoreId ?? "");
  const [userId, setUserId] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);

  const storesQuery = useQuery({
    queryKey: ["stores"],
    queryFn: () => apiRequest<{ stores: Store[] }>("/stores"),
  });

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("pageSize", "50");
    if (storeId) params.set("storeId", storeId);
    if (userId.trim()) params.set("userId", userId.trim());
    if (action) params.set("action", action);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params.toString();
  }, [page, storeId, userId, action, from, to]);

  const auditQuery = useQuery({
    queryKey: ["audit", queryString],
    queryFn: () => apiRequest<AuditResponse>(`/audit?${queryString}`),
  });

  const actions = auditQuery.data?.actions ?? [];
  const logs = auditQuery.data?.logs ?? [];

  const columns: DataTableColumn<AuditLogEntry>[] = [
    {
      id: "when",
      header: "When",
      cell: (log) => (
        <span className="whitespace-nowrap text-ink-muted">
          {new Date(log.createdAt).toLocaleString()}
        </span>
      ),
    },
    {
      id: "action",
      header: "Action",
      cell: (log) => <span className="font-semibold">{log.action}</span>,
    },
    {
      id: "actor",
      header: "Actor",
      cell: (log) => (
        <span className="font-mono text-xs">{log.userId ?? "—"}</span>
      ),
    },
    {
      id: "entity",
      header: "Entity",
      cell: (log) => (
        <div>
          <div>{log.entityType}</div>
          <div className="font-mono text-xs text-ink-muted">{log.entityId ?? "—"}</div>
        </div>
      ),
    },
    {
      id: "before",
      header: "Before",
      cell: (log) => (
        <span className="block max-w-xs truncate font-mono text-xs text-ink-muted">
          {formatJson(log.before)}
        </span>
      ),
    },
    {
      id: "after",
      header: "After",
      cell: (log) => (
        <span className="block max-w-xs truncate font-mono text-xs text-ink-muted">
          {formatJson(log.after)}
        </span>
      ),
    },
    {
      id: "ip",
      header: "IP",
      cell: (log) => (
        <span className="font-mono text-xs">{log.ipAddress ?? "—"}</span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description="Append-only trail of sensitive changes (operator %, stock, payouts, refunds, auth). Records cannot be edited or deleted."
      />

      <Card title="Filters">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            void auditQuery.refetch();
          }}
        >
          <SelectField
            label="Store"
            value={storeId}
            onChange={(e) => {
              setStoreId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All stores</option>
            {(storesQuery.data?.stores ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectField>
          <Field
            label="User id"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="cuid…"
          />
          <SelectField
            label="Action"
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All actions</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </SelectField>
          <Field
            label="From"
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
          <Field
            label="To"
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
          <div className="flex items-end">
            <Button type="submit" className="w-full">
              Apply filters
            </Button>
          </div>
        </form>
      </Card>

      {auditQuery.isError && (
        <p className="text-sm text-state-danger" role="alert">
          Failed to load audit log.
        </p>
      )}

      <DataTable
        columns={columns}
        rows={logs}
        rowKey={(log) => log.id}
        emptyMessage={
          auditQuery.isLoading ? "Loading…" : "No audit events match these filters."
        }
      />

      <div className="flex items-center justify-between text-sm">
        <p className="text-ink-muted">
          {auditQuery.data
            ? `${auditQuery.data.total} event${auditQuery.data.total === 1 ? "" : "s"}`
            : "…"}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="quiet"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </Button>
          <span className="px-2 py-2 text-ink-muted">
            Page <span className="tabular">{page}</span>
            {auditQuery.data?.totalPages ? (
              <>
                {" "}
                / <span className="tabular">{auditQuery.data.totalPages}</span>
              </>
            ) : null}
          </span>
          <Button
            type="button"
            variant="quiet"
            disabled={
              !auditQuery.data ||
              auditQuery.data.totalPages === 0 ||
              page >= auditQuery.data.totalPages
            }
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
