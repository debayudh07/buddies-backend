import { prisma } from '../../lib/prisma';

const CONSUMER_BID_SLOTS = 5;
const SUPPLIER_BID_CAP = 5;
const SUPPLIER_PREMIUM_BID_CAP = 50;

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

export async function getSupplierBidCap(userId: string): Promise<number> {
  const sub = await getActiveSubscription(userId);
  if (sub?.plan === 'supplier_premium') return SUPPLIER_PREMIUM_BID_CAP;
  return SUPPLIER_BID_CAP;
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

export { CONSUMER_BID_SLOTS, SUPPLIER_BID_CAP, SUPPLIER_PREMIUM_BID_CAP };
