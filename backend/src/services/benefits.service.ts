/**
 * Member benefits resolution for checkout (hot path).
 *
 * HARD RULES:
 * 1. Benefits NEVER apply to sales tax (tax is remitted to the state, not discounted).
 * 2. CapitalInvestment payments are NOT sales — this service is never called from
 *    membership.service / CapitalInvestment flows.
 * 3. All money math uses Prisma.Decimal via moneyDec — no JS floating point.
 * 4. Benefits are network-wide (MemberBenefit has no membership class filter).
 *
 * Caching: active benefits are cached in-process under a single global key with a short TTL.
 * Invalidate on create / soft-end / any write that changes what checkout should see
 * (see invalidateBenefitCache).
 */
import {
  BenefitPeriod,
  BenefitScope,
  BenefitType,
  Prisma,
  type MemberBenefit,
} from "@prisma/client";
import { moneyDec } from "../lib/money.js";

/** In-memory cache TTL — short so admin changes appear quickly even if invalidation is missed. */
const BENEFIT_CACHE_TTL_MS = 30_000;

/** Single cache key — benefits are network-wide, not per class. */
const GLOBAL_BENEFIT_CACHE_KEY = "all";

type BenefitCacheEntry = {
  expiresAt: number;
  benefits: MemberBenefit[];
};

/**
 * Active benefits cached globally (one entry for the whole network).
 *
 * INVALIDATION STRATEGY:
 * - Call invalidateBenefitCache() after creating a new benefit version,
 *   setting endsAt on an old row, flipping isActive, or otherwise mutating MemberBenefit.
 * - Optional unused arg is accepted for back-compat with older call sites; always clears
 *   the global cache.
 * - TTL is a safety net only — writers MUST invalidate; do not rely on expiry alone for
 *   correctness of "what was promised" at the next checkout.
 */
const activeBenefitsCache = new Map<string, BenefitCacheEntry>();

/** Clears cached active benefits so the next checkout reloads from the DB. */
export function invalidateBenefitCache(_unused?: string): void {
  activeBenefitsCache.clear();
}

/** One cart line at PRE-TAX retail — never include tax in unitPrice / lineGross. */
export type BenefitCartLine = {
  /** Stable key for mapping results (use index when the same product appears twice). */
  lineKey: string;
  productId: string;
  /** Product.category string — matched when BenefitScope = CATEGORY via scopeRefId. */
  category: string;
  quantity: number;
  /** Unit retail price (pre-tax). lineGross = unitPrice × quantity. */
  unitPrice: Prisma.Decimal | string | number;
};

export type LineBenefitApplication = {
  lineKey: string;
  productId: string;
  /** Pre-tax line gross before any benefit. */
  lineGross: Prisma.Decimal;
  /** Winning benefit for this line, or null if none applied. */
  benefitId: string | null;
  /** Dollar amount of the benefit discount on this line (never includes tax). */
  benefitDiscountAmount: Prisma.Decimal;
};

/**
 * A promised perk that did not apply — always surfaced so POS can explain to the cashier.
 * Never silently omit a capped / ineligible benefit.
 */
export type SkippedBenefit = {
  benefitId: string;
  description: string;
  reason: string;
};

export type ResolveBenefitsResult = {
  lines: LineBenefitApplication[];
  /** Sum of per-line benefit discounts (pre-tax). */
  memberDiscountAmount: Prisma.Decimal;
  /** Distinct benefit ids that won on at least one line. */
  appliedBenefitIds: string[];
  skipped: SkippedBenefit[];
};

type DbClient = Prisma.TransactionClient | typeof import("../lib/prisma.js").prisma;

function isCheckoutDiscountType(type: BenefitType): boolean {
  return (
    type === BenefitType.PERCENT_DISCOUNT ||
    type === BenefitType.FIXED_DISCOUNT ||
    type === BenefitType.FREE_ITEM ||
    type === BenefitType.BULK_PRICING ||
    type === BenefitType.BIRTHDAY_CREDIT ||
    type === BenefitType.STORE_CREDIT
  );
}

/**
 * Dollar discount a benefit would give on one pre-tax line gross.
 * PERCENT / BULK_PRICING: value is a percent of lineGross.
 * FIXED / FREE_ITEM / BIRTHDAY / STORE_CREDIT: value is USD, capped at lineGross.
 */
function computeLineDiscount(benefit: MemberBenefit, lineGross: Prisma.Decimal): Prisma.Decimal {
  if (lineGross.lte(0)) return moneyDec(0);

  if (
    benefit.benefitType === BenefitType.PERCENT_DISCOUNT ||
    benefit.benefitType === BenefitType.BULK_PRICING
  ) {
    return moneyDec(lineGross.mul(benefit.value).div(100));
  }

  if (
    benefit.benefitType === BenefitType.FIXED_DISCOUNT ||
    benefit.benefitType === BenefitType.FREE_ITEM ||
    benefit.benefitType === BenefitType.BIRTHDAY_CREDIT ||
    benefit.benefitType === BenefitType.STORE_CREDIT
  ) {
    const fixed = moneyDec(benefit.value);
    return fixed.gt(lineGross) ? moneyDec(lineGross) : fixed;
  }

  // FREE_DELIVERY / EARLY_ACCESS / EXCLUSIVE_PRODUCT — not line-price discounts at POS.
  return moneyDec(0);
}

function periodWindowStart(periodType: BenefitPeriod, now: Date): Date | null {
  switch (periodType) {
    case BenefitPeriod.PER_TRANSACTION:
      // Cap is enforced in-memory for this cart only — no historical window.
      return null;
    case BenefitPeriod.DAILY:
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    case BenefitPeriod.MONTHLY:
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    case BenefitPeriod.ANNUAL:
      return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    case BenefitPeriod.LIFETIME:
      return new Date(0);
    default:
      return null;
  }
}

async function loadActiveBenefits(now: Date, tx: DbClient): Promise<MemberBenefit[]> {
  const cached = activeBenefitsCache.get(GLOBAL_BENEFIT_CACHE_KEY);
  if (cached && cached.expiresAt > Date.now()) {
    // Still filter by window in case TTL spans a startsAt/endsAt boundary.
    return cached.benefits.filter(
      (b) => b.startsAt <= now && (b.endsAt == null || b.endsAt > now) && b.isActive,
    );
  }

  // 1) Load ALL ACTIVE network-wide MemberBenefit rows where now ∈ [startsAt, endsAt).
  const benefits = await tx.memberBenefit.findMany({
    where: {
      isActive: true,
      startsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });

  activeBenefitsCache.set(GLOBAL_BENEFIT_CACHE_KEY, {
    expiresAt: Date.now() + BENEFIT_CACHE_TTL_MS,
    benefits,
  });

  return benefits;
}

/**
 * Whether a benefit's scope includes this store + line.
 *
 * 3) Match scope:
 *    - ALL_PRODUCTS → every line
 *    - CATEGORY / PRODUCT → scopeRefId must match line.category / line.productId
 *    - STORE → scopeRefId must equal storeId
 *    - NETWORK_WIDE → any store that honors network benefits (caller already gated)
 */
function scopeMatchesLine(
  benefit: MemberBenefit,
  storeId: string,
  line: BenefitCartLine,
): boolean {
  switch (benefit.scope) {
    case BenefitScope.ALL_PRODUCTS:
    case BenefitScope.NETWORK_WIDE:
      return true;
    case BenefitScope.CATEGORY:
      return benefit.scopeRefId != null && benefit.scopeRefId === line.category;
    case BenefitScope.PRODUCT:
      return benefit.scopeRefId != null && benefit.scopeRefId === line.productId;
    case BenefitScope.STORE:
      return benefit.scopeRefId != null && benefit.scopeRefId === storeId;
    default:
      return false;
  }
}

/**
 * Resolves which member benefits apply to this cart at checkout.
 *
 * Benefits are network-wide — any ACTIVE member at a store that honors network benefits
 * may receive them. Never called for CapitalInvestment / membership.service flows.
 *
 * Returns per-line benefit discounts + applicable benefit ids. Skipped perks always include
 * a cashier-facing reason (caps, min purchase, scope, non-discount types).
 *
 * @param memberId Owner receiving perks (used for usage-cap queries)
 * @param storeId Checkout store (honorsNetworkBenefits + STORE scope)
 * @param cartLines Pre-tax retail lines only — never tax, never capital
 * @param tx Transaction client from createSale (same FOR UPDATE txn)
 */
export async function resolveBenefits(
  memberId: string,
  storeId: string,
  cartLines: BenefitCartLine[],
  tx: DbClient,
): Promise<ResolveBenefitsResult> {
  const emptyLines: LineBenefitApplication[] = cartLines.map((line) => {
    const lineGross = moneyDec(new Prisma.Decimal(line.unitPrice).mul(line.quantity));
    return {
      lineKey: line.lineKey,
      productId: line.productId,
      lineGross,
      benefitId: null,
      benefitDiscountAmount: moneyDec(0),
    };
  });

  const emptyResult = (): ResolveBenefitsResult => ({
    lines: emptyLines,
    memberDiscountAmount: moneyDec(0),
    appliedBenefitIds: [],
    skipped: [],
  });

  // 7) This function only sees grocery cart lines. CapitalInvestment never calls here.
  //    Tax is never part of unitPrice / lineGross — discounts are PRE-TAX only.
  if (!memberId || cartLines.length === 0) {
    return emptyResult();
  }

  const store = await tx.store.findUnique({
    where: { id: storeId },
    select: { id: true, honorsNetworkBenefits: true },
  });
  if (!store) {
    return emptyResult();
  }

  // 2) Store opted out of network member benefits (e.g. mid-onboarding) → zero discounts.
  if (!store.honorsNetworkBenefits) {
    return {
      ...emptyResult(),
      skipped: [
        {
          benefitId: "*",
          description: "Network benefits",
          reason: "Store does not honor network member benefits (honorsNetworkBenefits=false)",
        },
      ],
    };
  }

  const now = new Date();
  const benefits = await loadActiveBenefits(now, tx);

  // Cart gross (pre-tax) for minimumPurchaseAmount checks — never includes tax.
  const cartGross = moneyDec(
    cartLines.reduce(
      (sum, line) => sum.add(new Prisma.Decimal(line.unitPrice).mul(line.quantity)),
      new Prisma.Decimal(0),
    ),
  );

  const skipped: SkippedBenefit[] = [];
  const eligible: MemberBenefit[] = [];

  // Usage counts loaded once per benefit that has a cap (indexed query).
  const usageCountByBenefit = new Map<string, number>();
  /** In-cart applications for PER_TRANSACTION (and remaining capacity for period caps). */
  const usedThisCart = new Map<string, number>();

  for (const benefit of benefits) {
    // 4) Skip when cart gross is below the benefit's minimum purchase.
    if (cartGross.lt(benefit.minimumPurchaseAmount)) {
      skipped.push({
        benefitId: benefit.id,
        description: benefit.description || benefit.benefitType,
        reason: `Cart gross ${cartGross.toFixed(2)} is below minimum purchase ${moneyDec(benefit.minimumPurchaseAmount).toFixed(2)}`,
      });
      continue;
    }

    if (!isCheckoutDiscountType(benefit.benefitType)) {
      skipped.push({
        benefitId: benefit.id,
        description: benefit.description || benefit.benefitType,
        reason: `Benefit type ${benefit.benefitType} does not reduce line price at checkout`,
      });
      continue;
    }

    // 5) Enforce maxUsesPerPeriod via MemberBenefitUsage within periodType.
    if (benefit.maxUsesPerPeriod != null) {
      let priorUses = 0;
      if (benefit.periodType === BenefitPeriod.PER_TRANSACTION) {
        priorUses = 0; // only this cart counts
      } else {
        const windowStart = periodWindowStart(benefit.periodType, now);
        priorUses = await tx.memberBenefitUsage.count({
          where: {
            memberId,
            benefitId: benefit.id,
            ...(windowStart ? { usedAt: { gte: windowStart } } : {}),
          },
        });
      }
      usageCountByBenefit.set(benefit.id, priorUses);
      if (priorUses >= benefit.maxUsesPerPeriod) {
        // Cap hit — skip AND explain; never silently drop a promised perk.
        skipped.push({
          benefitId: benefit.id,
          description: benefit.description || benefit.benefitType,
          reason: `Usage cap reached (${priorUses}/${benefit.maxUsesPerPeriod} per ${benefit.periodType})`,
        });
        continue;
      }
    }

    eligible.push(benefit);
  }

  // Sort once for conflict resolution:
  // 6) When several benefits could apply to one line:
  //    (a) lower priority number first (explicit admin ordering),
  //    (b) among equal priority, pick best-for-customer (largest dollar discount).
  //    We evaluate candidates per line in priority order, then choose the max discount
  //    among the best priority tier that produced a positive discount.
  eligible.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  const lines: LineBenefitApplication[] = [];
  const appliedBenefitIds = new Set<string>();

  for (const line of cartLines) {
    const lineGross = moneyDec(new Prisma.Decimal(line.unitPrice).mul(line.quantity));

    type Candidate = { benefit: MemberBenefit; discount: Prisma.Decimal };
    const candidates: Candidate[] = [];

    for (const benefit of eligible) {
      if (!scopeMatchesLine(benefit, storeId, line)) {
        continue;
      }

      // Remaining capacity after in-cart uses this resolve call.
      if (benefit.maxUsesPerPeriod != null) {
        const prior = usageCountByBenefit.get(benefit.id) ?? 0;
        const inCart = usedThisCart.get(benefit.id) ?? 0;
        if (prior + inCart >= benefit.maxUsesPerPeriod) {
          continue;
        }
      }

      const discount = computeLineDiscount(benefit, lineGross);
      if (discount.lte(0)) continue;
      candidates.push({ benefit, discount });
    }

    let winner: Candidate | null = null;
    if (candidates.length) {
      // Best priority tier = minimum priority number among candidates.
      const bestPriority = Math.min(...candidates.map((c) => c.benefit.priority));
      const atTier = candidates.filter((c) => c.benefit.priority === bestPriority);
      // Best-for-customer within that tier: largest discount amount.
      winner = atTier.reduce((best, cur) =>
        cur.discount.gt(best.discount) ? cur : best,
      );
    }

    if (winner) {
      usedThisCart.set(winner.benefit.id, (usedThisCart.get(winner.benefit.id) ?? 0) + 1);
      appliedBenefitIds.add(winner.benefit.id);
      lines.push({
        lineKey: line.lineKey,
        productId: line.productId,
        lineGross,
        benefitId: winner.benefit.id,
        benefitDiscountAmount: winner.discount,
      });
    } else {
      lines.push({
        lineKey: line.lineKey,
        productId: line.productId,
        lineGross,
        benefitId: null,
        benefitDiscountAmount: moneyDec(0),
      });
    }
  }

  // Benefits that were eligible but matched no line scope — explain to cashier.
  for (const benefit of eligible) {
    if (appliedBenefitIds.has(benefit.id)) continue;
    if (skipped.some((s) => s.benefitId === benefit.id)) continue;
    const matchedAny = cartLines.some((line) => scopeMatchesLine(benefit, storeId, line));
    if (!matchedAny) {
      skipped.push({
        benefitId: benefit.id,
        description: benefit.description || benefit.benefitType,
        reason: "No cart lines matched this benefit's scope",
      });
    } else if ((usedThisCart.get(benefit.id) ?? 0) === 0) {
      skipped.push({
        benefitId: benefit.id,
        description: benefit.description || benefit.benefitType,
        reason: "Another higher-priority or better benefit won on matching lines",
      });
    }
  }

  const memberDiscountAmount = moneyDec(
    lines.reduce((sum, line) => sum.add(line.benefitDiscountAmount), new Prisma.Decimal(0)),
  );

  return {
    lines,
    memberDiscountAmount,
    appliedBenefitIds: [...appliedBenefitIds],
    skipped,
  };
}
