# Harvestlink membership

Harvestlink is a registered cooperative. Members are **owners**, not subscribers.

## Plain English

- **Owners, not subscribers.** Joining means paying a one-time **joining fee** and, separately,
  optionally making a **capital investment**. There is no monthly fee and no renewal date.
- **Fee and investment are separate.**
  - **MembershipFee ($100 joining fee)** — makes someone a member. Confers **NO** voting rights.
  - **CapitalInvestment ($1,000+)** — equity stake. Required before a member may vote. Amount is
    variable (someone may invest $5,000). Additional investments **add** new rows; they never
    replace prior investments.
- **Investments are equity, not revenue.** Capital must never be mixed into store sales, operator
  settlement, or P&L. Store operators earn **no percentage** on capital investments.
- **Memberships never expire.** A member stays a member until they withdraw (or another soft
  status change). POS only checks that status is `ACTIVE` — there is no expiry date.
- **One member, one vote — among members with voting rights.** A member votes only when
  `hasVotingRights` is true (`totalInvested` ≥ `CooperativeSettings.votingThresholdAmount`,
  default **$1,000**). Above the threshold every voting member gets **exactly one vote**, whether
  they invested $1,000 or $50,000. Investing more buys more dividend participation, never more
  votes.
- **Dividends by capital.** When the board declares a pool with allocation method `BY_CAPITAL`,
  each member’s share is proportional to their `totalInvested` (sum of **CONFIRMED** capital
  investments). Dividends need a `PASSED` board resolution first — not an admin shortcut.

## Status lifecycle

`PENDING` → `ACTIVE` → (`SUSPENDED` / `WITHDRAWN` / `DECEASED` / `TRANSFERRED`)

Members are never hard-deleted. Withdrawal is: request → board review → refund capital under
the bylaws → mark `WITHDRAWN`, keeping investment and dividend history forever.

## Developer rules

1. Equity money → `membership.service` / `/members/contributions` (`CapitalInvestment`) only —
   never `createSale`. Joining fees → `MembershipFee` (separate model; no votes).
2. POS member check → `status === ACTIVE` only.
3. Ballot eligibility → prefer `hasVotingRights` (and soft `isEligibleToVote`); never weight votes
   by dollars invested.
4. Dividends → require a `PASSED` `BoardResolution` first; `BY_CAPITAL` uses `totalInvested`.
5. Voting threshold → read `CooperativeSettings.votingThresholdAmount`; never hardcode `$1,000`.
6. Removing a member → status change + refund flow, never `DELETE`.
7. `MembershipClass` is gone. Benefits are network-wide (`MemberBenefit` has no class id).
