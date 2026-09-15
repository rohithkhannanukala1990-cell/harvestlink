/**
 * Members directory — co-op OWNERS (equity), not subscription tiers.
 * Capital contributions are recorded via /members/contributions (COOP_ADMIN), never POS.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest, money } from "../api/client";
import type { Member, MembershipClass, Sale } from "../api/types";
import { useAuth } from "../auth/AuthContext";

export function MembersPage() {
  const { isRole } = useAuth();
  const canManage = isRole("STORE_ADMIN", "COOP_ADMIN");
  const isCoop = isRole("COOP_ADMIN");
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    membershipClassId: "",
    activate: true,
  });
  const [contribAmount, setContribAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const classesQuery = useQuery({
    queryKey: ["membership-classes"],
    queryFn: () =>
      apiRequest<{ classes: MembershipClass[] }>("/members/classes?active=true"),
  });

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
      apiRequest<{ member: Member }>("/members", {
        method: "POST",
        body: {
          name: form.name,
          email: form.email,
          phone: form.phone || undefined,
          membershipClassId: form.membershipClassId,
          activate: form.activate,
        },
      }),
    onSuccess: () => {
      setForm((f) => ({ ...f, name: "", email: "", phone: "" }));
      setError(null);
      setMessage("Member created");
      void qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Create failed"),
  });

  const contributeMutation = useMutation({
    mutationFn: () =>
      apiRequest("/members/contributions", {
        method: "POST",
        body: {
          memberId: selectedId,
          amount: Number(contribAmount),
          markPaid: true,
        },
      }),
    onSuccess: () => {
      setContribAmount("");
      setMessage("Capital contribution recorded (equity — not store revenue)");
      void qc.invalidateQueries({ queryKey: ["member-history", selectedId] });
      void qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Contribution failed"),
  });

  const defaultClassId = classesQuery.data?.classes[0]?.id ?? "";
  useEffect(() => {
    if (!form.membershipClassId && defaultClassId) {
      setForm((f) => ({ ...f, membershipClassId: defaultClassId }));
    }
  }, [defaultClassId, form.membershipClassId]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Members (owners)</h1>
      <p className="text-sm text-stone-600">
        Lifetime capital contribution — memberships never expire. Capital is equity, not sales
        revenue.
      </p>
      {(message || error) && (
        <p className={`text-sm ${error ? "text-red-700" : "text-stone-600"}`}>
          {error ?? message}
        </p>
      )}

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
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            createMutation.mutate();
          }}
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
            Class
            <select
              className="mt-1 w-full rounded border border-stone-300 px-2 py-1"
              value={form.membershipClassId}
              onChange={(e) => setForm((f) => ({ ...f, membershipClassId: e.target.value }))}
              required
            >
              {(classesQuery.data?.classes ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({money(c.contributionAmount)})
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <button type="submit" className="rounded bg-stone-900 px-4 py-2 text-white">
              Create
            </button>
          </div>
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
                <span className="text-sm text-stone-500">
                  {m.status}
                  {m.membershipClass ? ` · ${m.membershipClass.name}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {canManage && (
          <section className="space-y-4 rounded-lg border border-stone-200 bg-white p-4">
            <h2 className="font-medium">Detail</h2>
            {!selectedId && (
              <p className="text-sm text-stone-500">Select a member.</p>
            )}
            {historyQuery.data && (
              <>
                <p className="text-sm">
                  Equity contributed:{" "}
                  {money(historyQuery.data.member.equityAccount?.totalContributed ?? 0)}
                  {" · "}
                  Vote eligible: {historyQuery.data.member.isEligibleToVote ? "yes" : "no"}
                </p>
                {isCoop && (
                  <div className="flex gap-2">
                    <input
                      className="rounded border border-stone-300 px-2 py-1"
                      placeholder="Capital $"
                      value={contribAmount}
                      onChange={(e) => setContribAmount(e.target.value)}
                    />
                    <button
                      type="button"
                      className="rounded bg-emerald-800 px-3 py-1 text-sm text-white"
                      onClick={() => contributeMutation.mutate()}
                    >
                      Record capital (equity)
                    </button>
                  </div>
                )}
                <h3 className="text-sm font-medium">Purchase history (all stores)</h3>
                <ul className="space-y-2 text-sm">
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
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
