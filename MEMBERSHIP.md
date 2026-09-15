# Harvestlink membership model

Harvestlink is a **registered cooperative**. Members are **owners**, not subscribers.

## What changed (and why)

The old model used a `MemberTier` enum (`STANDARD` / `PLUS` / `EXECUTIVE`) and a required
`expiresAt` date. That came from a subscription-style design. It does **not** apply here.

- Memberships are a **one-time lifetime capital contribution** ($100 or $1,000).
- Memberships **never expire**.
- Capital is **equity**, not store revenue. Operators earn **no percentage** on it.
- Voting is **one member, one vote** — never weighted by how much someone contributed.

## Core concepts

### MembershipClass

Defines the buy-in: name, `contributionAmount`, `dividendWeight`, and `votingRights`.

`votingRights` is **always 1** for every class. It exists as stored data so
one-member-one-vote is explicit and auditable — not an assumption buried in code.

Seeded classes:

- `Member $100`
- `Member $1,000`

### Member

Owners identified by `memberNumber` (POS card lookup). Status lifecycle:

`PENDING` → `ACTIVE` → (`SUSPENDED` / `WITHDRAWN` / `DECEASED` / `TRANSFERRED`)

**Members are never hard-deleted.** Withdrawal is: request → board review → refund capital →
`WITHDRAWN`, preserving contribution and dividend history.

POS attaches a member to a sale only when `status = ACTIVE` (no expiry check).

### CapitalContribution

Each payment of equity is a **new row**. Upgrading $100 → $1,000 **adds** a contribution;
it does not replace the old one. Dividend weight uses **total** contributed capital; voting
stays at 1.

**Hard rule:** capital never flows through `createSale` or settlement. It is recorded only
via `membership.service` / `/members/contributions`. Exclude it from sales reports, store
revenue, operator settlement, and P&L.

### MemberEquityAccount

Running totals: `totalContributed`, `distributedToDate`, `currentBalance`.

### BoardResolution → Dividend → DividendAllocation

A dividend **cannot** be created without a board resolution that has `PASSED`.

`allocationMethod` is configurable on purpose:

- `BY_CAPITAL` — by investment (Harvestlink’s current terms)
- `BY_PATRONAGE` — by how much the member buys (classic co-op)
- `HYBRID` — blend

Legal counsel may advise changing the method; never hardcode the formula in callers.

**Tax forms:** whether a distribution needs **1099-PATR** vs **1099-DIV** depends on
classification. Confirm with the co-op’s accountant before setting `taxFormIssued`.

### Ballot / MemberVote

One vote per ACTIVE eligible member. Enforced by a unique constraint on
`(ballotId, memberId)` **and** application checks. Never weight votes by capital.

## Developer checklist

1. Need equity money? → `membership.service` only.
2. Need POS member check? → `status === ACTIVE` only.
3. Need a dividend? → require a passed `BoardResolution` first.
4. Need to remove a member? → status change + refund flow, never `DELETE`.
