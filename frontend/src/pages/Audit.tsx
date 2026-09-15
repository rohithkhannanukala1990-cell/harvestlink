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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-stone-600">
          Append-only trail of sensitive changes (operator %, stock, payouts, refunds, auth).
          Records cannot be edited or deleted.
        </p>
      </div>

      <form
        className="grid gap-3 rounded-lg border border-stone-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          void auditQuery.refetch();
        }}
      >
        <label className="block text-sm">
          <span className="text-stone-600">Store</span>
          <select
            className="mt-1 w-full rounded border border-stone-300 px-3 py-2"
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
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-stone-600">User id</span>
          <input
            className="mt-1 w-full rounded border border-stone-300 px-3 py-2"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="cuid…"
          />
        </label>
        <label className="block text-sm">
          <span className="text-stone-600">Action</span>
          <select
            className="mt-1 w-full rounded border border-stone-300 px-3 py-2"
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
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-stone-600">From</span>
          <input
            type="date"
            className="mt-1 w-full rounded border border-stone-300 px-3 py-2"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="block text-sm">
          <span className="text-stone-600">To</span>
          <input
            type="date"
            className="mt-1 w-full rounded border border-stone-300 px-3 py-2"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <div className="flex items-end">
          <button
            type="submit"
            className="w-full rounded bg-stone-900 px-4 py-2 text-white hover:bg-stone-800"
          >
            Apply filters
          </button>
        </div>
      </form>

      {auditQuery.isError && (
        <p className="text-sm text-red-700">Failed to load audit log.</p>
      )}

      <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-stone-200 bg-stone-50 text-stone-600">
            <tr>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Actor</th>
              <th className="px-3 py-2 font-medium">Entity</th>
              <th className="px-3 py-2 font-medium">Before</th>
              <th className="px-3 py-2 font-medium">After</th>
              <th className="px-3 py-2 font-medium">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {(auditQuery.data?.logs ?? []).map((log) => (
              <tr key={log.id} className="align-top">
                <td className="whitespace-nowrap px-3 py-2 text-stone-600">
                  {new Date(log.createdAt).toLocaleString()}
                </td>
                <td className="px-3 py-2 font-medium">{log.action}</td>
                <td className="px-3 py-2 font-mono text-xs">{log.userId ?? "—"}</td>
                <td className="px-3 py-2">
                  <div>{log.entityType}</div>
                  <div className="font-mono text-xs text-stone-500">{log.entityId ?? "—"}</div>
                </td>
                <td className="max-w-xs truncate px-3 py-2 font-mono text-xs text-stone-600">
                  {formatJson(log.before)}
                </td>
                <td className="max-w-xs truncate px-3 py-2 font-mono text-xs text-stone-600">
                  {formatJson(log.after)}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{log.ipAddress ?? "—"}</td>
              </tr>
            ))}
            {!auditQuery.isLoading && (auditQuery.data?.logs.length ?? 0) === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-stone-500">
                  No audit events match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <p className="text-stone-600">
          {auditQuery.data
            ? `${auditQuery.data.total} event${auditQuery.data.total === 1 ? "" : "s"}`
            : "…"}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={page <= 1}
            className="rounded border border-stone-300 px-3 py-1 disabled:opacity-40"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </button>
          <span className="px-2 py-1 text-stone-600">
            Page {page}
            {auditQuery.data?.totalPages ? ` / ${auditQuery.data.totalPages}` : ""}
          </span>
          <button
            type="button"
            disabled={
              !auditQuery.data ||
              auditQuery.data.totalPages === 0 ||
              page >= auditQuery.data.totalPages
            }
            className="rounded border border-stone-300 px-3 py-1 disabled:opacity-40"
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
