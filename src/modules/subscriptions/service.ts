import type { Subscription, SubscriptionPlan } from '@prisma/client';
import { prisma } from '../../lib/prisma';

/**
 * Subscriptions run for one calendar month from startsAt. The end day is
 * clamped, so 31 Jan ends on 28/29 Feb rather than rolling into March.
 */
export function addOneMonth(from: Date): Date {
  const d = new Date(from);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

export type SubscriptionStatus = 'active' | 'expired' | 'replaced';

/**
 * - active: flagged active and still inside its month
 * - replaced: switched off before its month ran out (plan change)
 * - expired: ran its full month
 */
export function subscriptionStatus(
  sub: Pick<Subscription, 'active' | 'startsAt' | 'endsAt'>,
  now = new Date(),
): SubscriptionStatus {
  const end = sub.endsAt?.getTime();
  if (sub.active && (end == null || end > now.getTime())) return 'active';
  if (end != null && end > now.getTime()) return 'replaced';
  if (end != null && end < addOneMonth(sub.startsAt).getTime() - 60_000) return 'replaced';
  return 'expired';
}

export type SubscribeResult = {
  subscription: Subscription;
  /** 'created' = new month started; 'existing' = same plan already running; 'changed' = plan switched. */
  outcome: 'created' | 'existing' | 'changed';
};

/**
 * One live subscription per user. Re-subscribing to the running plan returns it
 * unchanged (no duplicate, no reset). Switching plan ends the current one now
 * and starts a fresh month on the new plan. A row lock on the user serialises
 * concurrent taps so two requests cannot both create a month.
 */
export async function subscribe(
  userId: string,
  plan: SubscriptionPlan,
  introPrice: boolean,
): Promise<SubscribeResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;

    const now = new Date();
    const live = await tx.subscription.findMany({
      where: { userId, active: true },
      orderBy: { createdAt: 'desc' },
    });
    const current = live.find((s) => !s.endsAt || s.endsAt > now) ?? null;

    // Tidy up: anything flagged active but past its end, plus stray extra actives.
    const stale = live.filter((s) => s !== current);
    for (const s of stale) {
      const ranOut = s.endsAt && s.endsAt <= now;
      await tx.subscription.update({
        where: { id: s.id },
        data: { active: false, ...(ranOut ? {} : { endsAt: now }) },
      });
    }

    if (current && current.plan === plan) {
      return { subscription: current, outcome: 'existing' as const };
    }

    if (current) {
      await tx.subscription.update({
        where: { id: current.id },
        data: { active: false, endsAt: now },
      });
    }

    const subscription = await tx.subscription.create({
      data: {
        userId,
        plan,
        active: true,
        introPrice,
        startsAt: now,
        endsAt: addOneMonth(now),
      },
    });
    return { subscription, outcome: current ? ('changed' as const) : ('created' as const) };
  });
}

const CONSUMER_BID_SLOTS = 5;
const SUPPLIER_BID_CAP = 5;
const SUPPLIER_PREMIUM_BID_CAP = 5;
const LOW_RATING_THRESHOLD = 3;
const LOW_RATING_BID_CAP = 2;
export const LOW_RATING_BID_CAP_REASON =
  'Rating below 3.0 — max 2 active bids until it recovers.';

export async function getActiveSubscription(userId: string) {
  const sub = await prisma.subscription.findFirst({
    where: { userId, active: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!sub) return null;
  // Expired premium must not keep elevated caps.
  if (sub.endsAt && sub.endsAt.getTime() < Date.now()) {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { active: false },
    });
    return null;
  }
  return sub;
}

export function applyRatingBidCap(planCap: number, rating: number | null | undefined): number {
  if (rating != null && rating < LOW_RATING_THRESHOLD) {
    return Math.min(planCap, LOW_RATING_BID_CAP);
  }
  return planCap;
}

export async function getSupplierBidQuotaInfo(userId: string): Promise<{
  cap: number;
  ratingLimited: boolean;
  reason: string | null;
}> {
  const sub = await getActiveSubscription(userId);
  const planCap = sub?.plan === 'supplier_premium' ? SUPPLIER_PREMIUM_BID_CAP : SUPPLIER_BID_CAP;
  const profile = await prisma.supplierProfile.findUnique({
    where: { userId },
    select: { rating: true },
  });
  const cap = applyRatingBidCap(planCap, profile?.rating);
  const ratingLimited = profile != null && profile.rating < LOW_RATING_THRESHOLD;
  return {
    cap,
    ratingLimited,
    reason: ratingLimited ? LOW_RATING_BID_CAP_REASON : null,
  };
}

export async function getSupplierBidCap(userId: string): Promise<number> {
  return (await getSupplierBidQuotaInfo(userId)).cap;
}

export async function expireSubscriptions(): Promise<number> {
  const result = await prisma.subscription.updateMany({
    where: {
      active: true,
      endsAt: { lt: new Date() },
    },
    data: { active: false },
  });
  return result.count;
}

export async function getConsumerBidSlots(_userId: string): Promise<number> {
  return CONSUMER_BID_SLOTS;
}

export {
  CONSUMER_BID_SLOTS,
  SUPPLIER_BID_CAP,
  SUPPLIER_PREMIUM_BID_CAP,
  LOW_RATING_THRESHOLD,
  LOW_RATING_BID_CAP,
};
