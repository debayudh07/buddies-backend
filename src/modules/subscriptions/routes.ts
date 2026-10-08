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
  subscribe,
  SUPPLIER_PLAN_PRICE_INR,
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
            inr: SUPPLIER_PLAN_PRICE_INR.supplier_standard.list,
            introInr: SUPPLIER_PLAN_PRICE_INR.supplier_standard.intro,
            months: 'first 3 months intro',
            concurrentBids: 5,
          },
          supplier_premium: {
            inr: SUPPLIER_PLAN_PRICE_INR.supplier_premium.list,
            concurrentBids: SUPPLIER_PREMIUM_BID_CAP,
          },
        }
      : {
          // Free during launch: `introInr` is the price actually charged, `inr`
          // is the list price shown struck through. The app reads both rather
          // than hardcoding either.
          consumer_standard: {
            inr: 299,
            introInr: 0,
            intro: 'Free during launch',
            slots: `${await getConsumerBidSlots(req.user!.id)} bid slots`,
          },
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

    const { subscription, outcome } = await subscribe(req.user!.id, plan, introPrice ?? false);

    res.status(outcome === 'existing' ? 200 : 201).json({
      subscription,
      outcome,
      note:
        outcome === 'existing'
          ? 'This plan is already active until endsAt; nothing was charged or changed'
          : 'Goods payments remain offline; this is platform subscription only',
    });
  },
);
