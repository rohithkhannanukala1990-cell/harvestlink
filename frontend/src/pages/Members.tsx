/**
 * Members directory — co-op OWNERS (equity), not subscription tiers.
 * Capital investments are recorded via /members/contributions (COOP_ADMIN), never POS.
 * Joining fee (MembershipFee) is separate from CapitalInvestment and confers no votes.
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "../api/client";
import type { Member, Sale } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import {
  Button,
  Card,
  DataTable,
  Field,
  MemberVotingBadge,
  Money,
  PageHeader,
  StatCard,
  formatMoney,
  type DataTableColumn,
} from "../components/ui";

type HistorySale = Sale & { store: { id: string; name: string } };

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
    activate: true,
  });
  const [contribAmount, setContribAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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
        sales: HistorySale[];
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
        },
      }),
    onSuccess: () => {
      setContribAmount("");
      setMessage("Capital investment recorded (equity — not store revenue)");
      void qc.invalidateQueries({ queryKey: ["member-history", selectedId] });
      void qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Investment failed"),
  });

  const members = membersQuery.data?.members ?? [];
  const detail = historyQuery.data?.member;

  const saleColumns: DataTableColumn<HistorySale>[] = [
    {
      id: "when",
      header: "Purchase",
      cell: (s) => (
        <span>
          {s.store.name} · {new Date(s.createdAt).toLocaleString()} · {s.paymentStatus}
        </span>
      ),
    },
    {
      id: "total",
      header: "Sale total",
      numeric: true,
      cell: (s) => <Money value={s.total} />,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Members (owners)"
        description="Lifetime capital investment — memberships never expire. Capital is equity, not sales revenue. A joining fee confers membership but no votes; capital at the voting threshold confers one vote — investing more never buys more votes."
      />
      {(message || error) && (
        <p
          className={`text-sm ${error ? "text-state-danger" : "text-ink-muted"}`}
          role={error ? "alert" : undefined}
        >
          {error ?? message}
        </p>
      )}

      <Field
        label="Search"
        className="max-w-md"
        placeholder="Search name or member number"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      {canManage && (
        <Card title="Add member">
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              createMutation.mutate();
            }}
            className="grid gap-3 sm:grid-cols-4"
          >
            <Field
              label="Name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
            <Field
              label="Email"
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              required
            />
            <Field
              label="Phone"
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            />
            <div className="flex items-end">
              <Button type="submit" loading={createMutation.isPending}>
                Create
              </Button>
            </div>
          </form>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Owners">
          <ul className="divide-y divide-border-hairline">
            {members.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className={`flex w-full items-center justify-between gap-3 px-1 py-3 text-left hover:bg-surface-sunken ${
                    selectedId === m.id ? "bg-surface-sunken" : ""
                  }`}
                  onClick={() => setSelectedId(m.id)}
                >
                  <span>
                    <span className="font-semibold text-ink">{m.name}</span>
                    <span className="ml-2 font-mono text-xs text-ink-muted">
                      {m.memberNumber}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-2">
                      <MemberVotingBadge hasVotingRights={m.hasVotingRights} />
                      <span className="text-xs text-ink-muted">{m.status}</span>
                    </span>
                  </span>
                  <span className="text-right text-sm">
                    <span className="block text-xs font-semibold uppercase tracking-wide text-brand-gold">
                      Capital invested
                    </span>
                    <Money value={m.totalInvested ?? 0} tone="capital" />
                  </span>
                </button>
              </li>
            ))}
            {members.length === 0 && (
              <li className="py-3 text-sm text-ink-muted">No members match.</li>
            )}
          </ul>
        </Card>

        {canManage && (
          <Card title="Detail">
            {!selectedId && <p className="text-sm text-ink-muted">Select a member.</p>}
            {detail && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <MemberVotingBadge hasVotingRights={detail.hasVotingRights} />
                  <span className="text-sm text-ink-muted">
                    {detail.status}
                    {detail.isEligibleToVote === false ? " · soft vote ineligible" : ""}
                  </span>
                </div>

                {/* Capital is gold and labelled as investment — never as a sale or payment. */}
                <StatCard
                  label="Capital invested (equity)"
                  value={formatMoney(detail.totalInvested ?? 0)}
                  tone="capital"
                  subLine="Not store revenue — one member, one vote above threshold"
                />

                {detail.equityAccount && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <StatCard
                      label="Equity contributions"
                      value={formatMoney(detail.equityAccount.totalContributed)}
                      tone="capital"
                    />
                    <StatCard
                      label="Equity balance"
                      value={formatMoney(detail.equityAccount.currentBalance)}
                      tone="capital"
                      subLine={
                        <>
                          Distributed{" "}
                          <Money
                            value={detail.equityAccount.distributedToDate}
                            tone="capital"
                          />
                        </>
                      }
                    />
                  </div>
                )}

                {isCoop && (
                  <div className="space-y-2 rounded-md border border-brand-gold/30 bg-brand-gold/10 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-brand-gold">
                      Record capital investment — equity, not a sale
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Field
                        label="Investment amount"
                        className="min-w-[8rem] flex-1"
                        value={contribAmount}
                        onChange={(e) => setContribAmount(e.target.value)}
                        placeholder="Capital $"
                      />
                      <div className="flex items-end">
                        <Button
                          type="button"
                          variant="quiet"
                          loading={contributeMutation.isPending}
                          onClick={() => contributeMutation.mutate()}
                        >
                          Record investment
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                <div>
                  <h3 className="mb-2 text-sm font-semibold text-ink">
                    Purchase history (all stores)
                  </h3>
                  <p className="mb-2 text-xs text-ink-muted">
                    Store sales only — capital investments never appear here.
                  </p>
                  <DataTable
                    columns={saleColumns}
                    rows={historyQuery.data?.sales ?? []}
                    rowKey={(s) => s.id}
                    emptyMessage="No purchases yet."
                  />
                </div>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
