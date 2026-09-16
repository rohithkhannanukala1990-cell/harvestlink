import { StatusBadge } from "./StatusBadge.tsx";

/**
 * Voting rights cue for member lists and detail.
 * Gold "Voting rights" when hasVotingRights; neutral "Fee only" for fee-only owners.
 * Never implies that investing more buys more votes — one member, one vote.
 */
export function MemberVotingBadge({
  hasVotingRights,
  className = "",
}: {
  hasVotingRights: boolean;
  className?: string;
}) {
  return hasVotingRights ? (
    <StatusBadge label="Voting rights" tone="gold" className={className} />
  ) : (
    <StatusBadge label="Fee only" tone="neutral" className={className} />
  );
}
