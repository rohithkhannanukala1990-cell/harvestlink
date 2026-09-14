/**
 * Members directory page (co-op-wide).
 *
 * APIs:
 * - GET /members?q= — list/search (CASHIER, STORE_ADMIN, COOP_ADMIN)
 * - POST /members — create (STORE_ADMIN, COOP_ADMIN)
 * - GET /members/:id/purchase-history — co-op-wide sales (STORE_ADMIN, COOP_ADMIN)
 * - GET /members/:memberNumber — also used indirectly via search results
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest, money } from "../api/client";
import type { Member, MemberTier, Sale } from "../api/types";
import { useAuth } from "../auth/AuthContext";

export function MembersPage() {
  const { isRole } = useAuth();
  const canManage = isRole("STORE_ADMIN", "COOP_ADMIN");
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    email: "",
    tier: "STANDARD" as MemberTier,
  });
  const [error, setError] = useState<string | null>(null);

  const membersQuery = useQuery({
    queryKey: ["members", q],
    queryFn: () =>
      apiRequest<{ members: Member[]; total: number }>(
        `/members?page=1&pageSize=50${q ? `&q=${encodeURIComponent(q)}` : ""}`,
      ),
  });

  const historyQuery = useQuery({
    queryKey: ["member-history", selectedId],
    enabled: !!selectedId && canManage,
    queryFn: () =>
      apiRequest<{
        member: Member;
        sales: Array<Sale & { store: { id: string; name: string } }>;
        total: number;
      }>(`/members/${selectedId}/purchase-history?page=1&pageSize=20`),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      apiRequest<{ member: Member }>("/members", { method: "POST", body: form }),
    onSuccess: () => {
      setForm({ name: "", email: "", tier: "STANDARD" });
      setError(null);
      void qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Create failed"),
  });

  function onCreate(e: FormEvent) {
    e.preventDefault();
    createMutation.mutate();
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Members</h1>

      <div className="flex gap-2">
        <input
          className="w-full max-w-md rounded border border-stone-300 px-3 py-2"
          placeholder="Search name or member number"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {canManage && (
        <form
          onSubmit={onCreate}
          className="grid gap-3 rounded-lg border border-stone-200 bg-white p-4 sm:grid-cols-4"
        >
          <h2 className="sm:col-span-4 font-medium">Add member</h2>
          <label className="text-sm">
            Name
            <input
              className="mt-1 w-full rounded border border-stone-300 px-2 py-1"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
          </label>
          <label className="text-sm">
            Email
            <input
              type="email"
              className="mt-1 w-full rounded border border-stone-300 px-2 py-1"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              required
            />
          </label>
          <label className="text-sm">
            Tier
            <select
              className="mt-1 w-full rounded border border-stone-300 px-2 py-1"
              value={form.tier}
              onChange={(e) => setForm((f) => ({ ...f, tier: e.target.value as MemberTier }))}
            >
              <option value="STANDARD">STANDARD</option>
              <option value="PLUS">PLUS</option>
              <option value="EXECUTIVE">EXECUTIVE</option>
            </select>
          </label>
          <div className="flex items-end">
            <button type="submit" className="rounded bg-stone-900 px-4 py-2 text-white">
              Create
            </button>
          </div>
          {error && <p className="sm:col-span-4 text-sm text-red-700">{error}</p>}
        </form>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white">
          {(membersQuery.data?.members ?? []).map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-stone-50"
                onClick={() => setSelectedId(m.id)}
              >
                <span>
                  <span className="font-medium">{m.name}</span>
                  <span className="ml-2 font-mono text-xs text-stone-500">{m.memberNumber}</span>
                </span>
                <span className="text-sm text-stone-500">{m.tier}</span>
              </button>
            </li>
          ))}
        </ul>

        {canManage && (
          <section className="rounded-lg border border-stone-200 bg-white p-4">
            <h2 className="font-medium">Purchase history (all stores)</h2>
            {!selectedId && (
              <p className="mt-2 text-sm text-stone-500">Select a member to load history.</p>
            )}
            {historyQuery.isLoading && <p className="mt-2 text-sm">Loading…</p>}
            {historyQuery.data && (
              <ul className="mt-3 space-y-2 text-sm">
                {historyQuery.data.sales.length === 0 && (
                  <li className="text-stone-500">No purchases yet.</li>
                )}
                {historyQuery.data.sales.map((s) => (
                  <li key={s.id} className="flex justify-between border-b border-stone-100 py-2">
                    <span>
                      {s.store.name} · {new Date(s.createdAt).toLocaleString()} ·{" "}
                      {s.paymentStatus}
                    </span>
                    <span>{money(s.total)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
