import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { AppError } from '../../lib/errors';
import {
  getActiveSubscription,
  getConsumerBidSlots,
  getSupplierBidQuotaInfo,
  SUPPLIER_PREMIUM_BID_CAP,
} from './service';

export const subscriptionsRouter = Router();

subscriptionsRouter.get('/subscriptions/me', authenticate, async (req, res) => {
  const sub = await getActiveSubscription(req.user!.id);
  const quotaInfo =
    req.user!.role === 'supplier' ? await getSupplierBidQuotaInfo(req.user!.id) : null;
  const cap =
    quotaInfo?.cap ?? (await getConsumerBidSlots(req.user!.id));

  let activeBids = 0;
  if (req.user!.role === 'supplier') {
    const profile = await prisma.supplierProfile.findUnique({ where: { userId: req.user!.id } });
    if (profile) {
      activeBids = await prisma.bid.count({
        where: {
          supplierId: profile.id,
          status: 'active',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      });
    }
  }

  const pricing =
    req.user!.role === 'supplier'
      ? {
          supplier_standard: {
            inr: 299,
            introInr: 99,
            months: 'first 3 months intro',
            concurrentBids: 5,
          },
          supplier_premium: {
            inr: 599,
            concurrentBids: SUPPLIER_PREMIUM_BID_CAP,
          },
        }
      : {
          consumer_standard: { inr: 299, slots: '5 bid slots' },
        };

  res.json({
    subscription: sub,
    quota: {
      cap,
      used: activeBids,
      remaining: Math.max(0, cap - activeBids),
      ...(quotaInfo?.reason ? { reason: quotaInfo.reason } : {}),
    },
    pricing,
  });
});

const subscribeSchema = z.object({
  plan: z.enum(['consumer_standard', 'supplier_standard', 'supplier_premium']),
  introPrice: z.boolean().optional(),
});

subscriptionsRouter.post(
  '/subscriptions',
  authenticate,
  validateBody(subscribeSchema),
  async (req, res) => {
    const { plan, introPrice } = req.body as z.infer<typeof subscribeSchema>;
    if (req.user!.role === 'consumer' && plan !== 'consumer_standard') {
      throw new AppError(400, 'INVALID_PLAN', 'Consumers must use consumer_standard');
    }
    if (req.user!.role === 'supplier' && plan === 'consumer_standard') {
      throw new AppError(400, 'INVALID_PLAN', 'Suppliers cannot use consumer_standard');
    }

    await prisma.subscription.updateMany({
      where: { userId: req.user!.id, active: true },
      data: { active: false },
    });

    const endsAt = new Date();
    endsAt.setMonth(endsAt.getMonth() + 1);

    const sub = await prisma.subscription.create({
      data: {
        userId: req.user!.id,
        plan: plan as never,
        active: true,
        introPrice: introPrice ?? false,
        endsAt,
      },
    });

    res.status(201).json({
      subscription: sub,
      note: 'Goods payments remain offline; this is platform subscription only',
    });
  },
);
