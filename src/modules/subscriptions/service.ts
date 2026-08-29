import { prisma } from '../../lib/prisma';

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
