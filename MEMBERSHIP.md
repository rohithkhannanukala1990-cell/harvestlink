# Harvestlink membership

Harvestlink is a registered cooperative. Members are **owners**, not subscribers.

## Plain English

- **Owners, not subscribers.** Joining means buying a stake in the co-op with a one-time
  lifetime capital contribution ($100 or $1,000). There is no monthly fee and no renewal date.
- **Contributions are equity, not revenue.** Money paid for membership is ownership capital.
  It must never be mixed into store sales, operator settlement, or P&L. Store operators earn
  **no percentage** on capital contributions.
- **Memberships never expire.** A member stays a member until they withdraw (or another soft
  status change). POS only checks that status is `ACTIVE` — there is no expiry date.
- **One member, one vote.** Voting power does not grow with how much capital someone put in.
  A member who contributed $100 and a member who contributed $1,100 each get exactly one vote.
- **Dividends need the board.** A dividend pool can only be declared after a board resolution
  has been approved (`PASSED`). It is a board decision, not an admin shortcut.

## How capital upgrades work

Paying more later (for example $100, then another $1,000) **adds** a new contribution row.
Dividend weight uses the **sum** of paid capital. Voting stays at one.

## Status lifecycle

`PENDING` → `ACTIVE` → (`SUSPENDED` / `WITHDRAWN` / `DECEASED` / `TRANSFERRED`)

Members are never hard-deleted. Withdrawal is: request → board review → refund capital under
the bylaws → mark `WITHDRAWN`, keeping contribution and dividend history forever.

## Developer rules

1. Equity money → `membership.service` / `/members/contributions` only — never `createSale`.
2. POS member check → `status === ACTIVE` only.
3. Dividends → require a `PASSED` `BoardResolution` first.
4. Removing a member → status change + refund flow, never `DELETE`.
