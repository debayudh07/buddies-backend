import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { authenticate, requireRole } from '../../middleware/auth';
import { cacheGet, cacheSet } from '../../lib/response-cache';
import { PRODUCT_CATEGORIES } from '../../lib/product-categories';

export const dashboardRouter = Router();

/** Category cart from product doc (for chip filters / spend buckets). */
const PRODUCT_CATEGORY_SLUGS = PRODUCT_CATEGORIES.map((c) => c.productCategory);
const FALLBACK_CATEGORIES = PRODUCT_CATEGORY_SLUGS;
const DASHBOARD_TTL_MS = 20_000;

function startOfMonth(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

dashboardRouter.get('/consumer/dashboard', authenticate, requireRole('consumer'), async (req, res) => {
  const userId = req.user!.id;
  const cacheKey = `dash:consumer:${userId}`;
  const cached = await cacheGet<Record<string, unknown>>(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    res.json(cached);
    return;
  }

  const monthStart = startOfMonth();

  // Single round: all queries keyed by userId / nested consumer relation (no serial profile).
  const [recentOrders, openBidRequests, totalOrders, closedOrders, subscription] =
    await Promise.all([
      prisma.order.findMany({
        where: { consumerUserId: userId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          orderCode: true,
          status: true,
          createdAt: true,
          deliveredAt: true,
          bid: { select: { amountPaise: true, grade: true } },
          bidRequest: {
            select: {
              budgetPaise: true,
              items: {
                select: { name: true, quantity: true, unit: true, productCategory: true },
                take: 5,
              },
            },
          },
          gstInvoice: { select: { id: true, invoiceNumber: true } },
        },
      }),
      prisma.bidRequest.count({
        where: {
          status: 'open',
          consumer: { userId },
        },
      }),
      prisma.order.count({ where: { consumerUserId: userId } }),
      prisma.order.findMany({
        where: {
          consumerUserId: userId,
          status: { in: ['delivered', 'closed', 'challan_signed'] },
          OR: [
            { deliveredAt: { gte: monthStart } },
            { deliveredAt: null, createdAt: { gte: monthStart } },
          ],
        },
        select: {
          bid: { select: { amountPaise: true } },
          bidRequest: {
            select: {
              budgetPaise: true,
              items: { select: { productCategory: true }, take: 1 },
            },
          },
        },
      }),
      prisma.subscription.findFirst({
        where: { userId, active: true },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          plan: true,
          active: true,
          startsAt: true,
          endsAt: true,
        },
      }),
    ]);

  let savingsPaise = 0;
  const spendingByCategory: Record<string, number> = {};

  for (const order of closedOrders) {
    const paid = order.bid.amountPaise;
    const budget = order.bidRequest.budgetPaise;
    if (budget != null) savingsPaise += budget - paid;

    const category = order.bidRequest.items[0]?.productCategory ?? 'General';
    spendingByCategory[category] = (spendingByCategory[category] ?? 0) + paid;
  }

  const payload = {
    recentOrders,
    openBidRequests,
    totalOrders,
    savingsPaise,
    spendingByCategory: Object.entries(spendingByCategory).map(([category, paise]) => ({
      category,
      paise,
    })),
    activeSubscription: subscription,
    categories: FALLBACK_CATEGORIES,
  };

  await cacheSet(cacheKey, payload, DASHBOARD_TTL_MS);
  res.setHeader('X-Cache', 'MISS');
  res.json(payload);
});
