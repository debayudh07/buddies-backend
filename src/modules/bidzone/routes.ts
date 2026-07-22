import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate, requireRole } from '../../middleware/auth';
import { requireParam } from '../../middleware/params';
import { validateBody } from '../../middleware/validate';
import { AppError, assertFound } from '../../lib/errors';
import { haversineKm } from '../../lib/haversine';
import { computeBidScore } from '../../lib/scoring';
import { getSupplierBidCap } from '../subscriptions/service';
import { config } from '../../config';
import { emitAuction } from '../../socket';
import { sendPush } from '../../lib/notify';
import { createOrderFromAcceptedBid } from '../orders/service';

export const bidzoneRouter = Router();

async function requireVerifiedSupplier(userId: string) {
  const profile = await prisma.supplierProfile.findUnique({ where: { userId } });
  if (!profile) throw new AppError(400, 'NO_KYC', 'Complete KYC first');
  if (profile.kycStatus !== 'verified') {
    throw new AppError(403, 'KYC_REQUIRED', 'Bidzone requires verified KYC');
  }
  return profile;
}

bidzoneRouter.get('/supplier/home', authenticate, requireRole('supplier'), async (req, res) => {
  const profile = await prisma.supplierProfile.findUnique({ where: { userId: req.user!.id } });
  const openCount = await prisma.bidRequest.count({ where: { status: 'open', liveEndsAt: { gt: new Date() } } });
  const activeOrders = await prisma.order.count({
    where: {
      supplierUserId: req.user!.id,
      status: { in: ['preparing', 'out_for_delivery', 'arrived', 'inspection_pending', 'bid_accepted'] },
    },
  });
  const activeBids = profile
    ? await prisma.bid.count({ where: { supplierId: profile.id, status: 'active' } })
    : 0;
  res.json({
    kycStatus: profile?.kycStatus ?? 'draft',
    openBidzoneCount: openCount,
    activeOrders,
    activeBids,
    performance: profile
      ? {
          rating: profile.rating,
          onTimeRate: profile.onTimeRate,
          returnRate: profile.returnRate,
          challanAdjustRate: profile.challanAdjustRate,
        }
      : null,
  });
});

bidzoneRouter.get('/supplier/bidzone', authenticate, requireRole('supplier'), async (req, res) => {
  const profile = await requireVerifiedSupplier(req.user!.id);
  const now = new Date();
  const requests = await prisma.bidRequest.findMany({
    where: { status: 'open', liveEndsAt: { gt: now } },
    include: { items: true },
    orderBy: { liveEndsAt: 'asc' },
    take: 50,
  });

  const feed = requests.map((r: (typeof requests)[number]) => {
    let distanceKm: number | null = null;
    if (profile.lat != null && profile.lng != null && r.lat != null && r.lng != null) {
      distanceKm = Math.round(haversineKm(profile.lat, profile.lng, r.lat, r.lng) * 10) / 10;
    }
    return {
      id: r.id,
      batchCode: r.batchCode,
      budgetPaise: r.budgetPaise,
      liveEndsAt: r.liveEndsAt,
      extendCount: r.extendCount,
      items: r.items,
      distanceKm,
      // Masked — no consumer address / restaurant name
      locationHint: distanceKm != null ? `~${distanceKm} km away` : 'Nearby',
    };
  });

  res.json({ feed });
});

const placeBidSchema = z.object({
  bidRequestId: z.string().uuid(),
  amountPaise: z.number().int().positive(),
  grade: z.string().min(1),
  shelfLifeDays: z.number().int().positive(),
  rslDaysAtDelivery: z.number().int().nonnegative(),
  notes: z.string().optional(),
});

bidzoneRouter.post(
  '/supplier/bids',
  authenticate,
  requireRole('supplier'),
  validateBody(placeBidSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof placeBidSchema>;
    const profile = await requireVerifiedSupplier(req.user!.id);

    const cap = await getSupplierBidCap(req.user!.id);
    const activeCount = await prisma.bid.count({
      where: { supplierId: profile.id, status: 'active' },
    });
    if (activeCount >= cap) {
      throw new AppError(403, 'BID_QUOTA_EXCEEDED', `Max ${cap} concurrent bids; upgrade to premium`);
    }

    const bidRequest = assertFound(
      await prisma.bidRequest.findUnique({ where: { id: body.bidRequestId }, include: { items: true } }),
    );
    if (bidRequest.status !== 'open') throw new AppError(400, 'NOT_OPEN', 'Auction not open');
    if (bidRequest.liveEndsAt < new Date()) throw new AppError(400, 'EXPIRED', 'Auction window ended');

    if (!body.grade || body.rslDaysAtDelivery < 0) {
      throw new AppError(400, 'RSL_REQUIRED', 'Grade and RSL required');
    }

    const best = await prisma.bid.findFirst({
      where: { bidRequestId: bidRequest.id, status: 'active' },
      orderBy: { amountPaise: 'asc' },
    });
    if (best && body.amountPaise > best.amountPaise - bidRequest.minDecrementPaise) {
      // allow first bid freely; subsequent must undercut by min decrement
      if (best.supplierId !== profile.id) {
        throw new AppError(
          400,
          'MIN_DECREMENT',
          `New bid must be at least ${bidRequest.minDecrementPaise} paise below current best`,
        );
      }
    }

    let distanceKm = 5;
    if (profile.lat != null && profile.lng != null && bidRequest.lat != null && bidRequest.lng != null) {
      distanceKm = haversineKm(profile.lat, profile.lng, bidRequest.lat, bidRequest.lng);
    }

    const { score, breakdown } = computeBidScore({
      amountPaise: body.amountPaise,
      budgetPaise: bidRequest.budgetPaise,
      rslDays: body.rslDaysAtDelivery,
      distanceKm,
      onTimeRate: profile.onTimeRate,
      rating: profile.rating,
    });

    // Auto-extend if near end
    let liveEndsAt = bidRequest.liveEndsAt;
    let extendCount = bidRequest.extendCount;
    const msLeft = liveEndsAt.getTime() - Date.now();
    if (
      msLeft <= config.auction.autoExtendTriggerSec * 1000 &&
      extendCount < config.auction.maxExtends
    ) {
      liveEndsAt = new Date(Date.now() + config.auction.autoExtendBySec * 1000);
      extendCount += 1;
      await prisma.bidRequest.update({
        where: { id: bidRequest.id },
        data: { liveEndsAt, extendCount },
      });
    }

    const bid = await prisma.bid.create({
      data: {
        bidRequestId: bidRequest.id,
        supplierId: profile.id,
        amountPaise: body.amountPaise,
        grade: body.grade,
        shelfLifeDays: body.shelfLifeDays,
        rslDaysAtDelivery: body.rslDaysAtDelivery,
        notes: body.notes,
        score,
        scoreBreakdown: breakdown,
        distanceKm,
        expiresAt: liveEndsAt,
      },
      include: {
        supplier: {
          select: { publicLabel: true, rating: true, onTimeRate: true, returnRate: true },
        },
      },
    });

    emitAuction(bidRequest.id, 'auction.bid_placed', {
      bid,
      liveEndsAt,
      extendCount,
    });

    const consumer = await prisma.consumerProfile.findUnique({ where: { id: bidRequest.consumerId } });
    if (consumer) {
      await sendPush({
        userId: consumer.userId,
        title: 'New bid',
        body: `${profile.publicLabel} bid ₹${(body.amountPaise / 100).toFixed(0)}`,
        data: { bidRequestId: bidRequest.id, bidId: bid.id },
      });
    }

    res.status(201).json({ bid, liveEndsAt, extendCount });
  },
);

bidzoneRouter.get('/supplier/bids', authenticate, requireRole('supplier'), async (req, res) => {
  const profile = await prisma.supplierProfile.findUnique({ where: { userId: req.user!.id } });
  if (!profile) return res.json({ bids: [] });
  const bids = await prisma.bid.findMany({
    where: { supplierId: profile.id },
    include: { bidRequest: { include: { items: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ bids });
});

bidzoneRouter.post('/supplier/bids/:id/withdraw', authenticate, requireRole('supplier'), async (req, res) => {
  const profile = await requireVerifiedSupplier(req.user!.id);
  const bid = assertFound(await prisma.bid.findUnique({ where: { id: requireParam(req, 'id') } }));
  if (bid.supplierId !== profile.id) throw new AppError(403, 'FORBIDDEN', 'Not your bid');
  if (bid.status !== 'active') throw new AppError(400, 'INVALID_STATE', 'Bid not active');
  const updated = await prisma.bid.update({
    where: { id: bid.id },
    data: { status: 'withdrawn' },
  });
  emitAuction(bid.bidRequestId, 'auction.bid_withdrawn', { bidId: bid.id });
  res.json({ bid: updated });
});

/** Consumer: list scored bids */
bidzoneRouter.get(
  '/consumer/bid-requests/:id/bids',
  authenticate,
  requireRole('consumer'),
  async (req, res) => {
    const bids = await prisma.bid.findMany({
      where: { bidRequestId: requireParam(req, 'id'), status: 'active' },
      include: {
        supplier: {
          select: {
            id: true,
            publicLabel: true,
            rating: true,
            onTimeRate: true,
            returnRate: true,
            challanAdjustRate: true,
            // never shopAddressPrivate
          },
        },
      },
      orderBy: { score: 'desc' },
    });
    res.json({ bids });
  },
);

/** Bind-on-accept */
bidzoneRouter.post(
  '/consumer/bids/:id/accept',
  authenticate,
  requireRole('consumer'),
  async (req, res) => {
    const bid = assertFound(
      await prisma.bid.findUnique({
        where: { id: requireParam(req, 'id') },
        include: { bidRequest: { include: { consumer: true } }, supplier: true },
      }),
    );
    if (bid.bidRequest.consumer.userId !== req.user!.id) {
      throw new AppError(403, 'FORBIDDEN', 'Not your request');
    }
    if (bid.status !== 'active') throw new AppError(400, 'INVALID_STATE', 'Bid not active');
    if (bid.bidRequest.status !== 'open') throw new AppError(400, 'NOT_OPEN', 'Already awarded');

    await prisma.$transaction([
      prisma.bid.update({
        where: { id: bid.id },
        data: { status: 'accepted', acceptedAt: new Date(), consumerAckAt: null },
      }),
      prisma.bid.updateMany({
        where: { bidRequestId: bid.bidRequestId, id: { not: bid.id }, status: 'active' },
        data: { status: 'rejected' },
      }),
      prisma.bidRequest.update({
        where: { id: bid.bidRequestId },
        data: { status: 'awarded', winningBidId: bid.id },
      }),
    ]);

    emitAuction(bid.bidRequestId, 'auction.bid_accepted', { bidId: bid.id });
    await sendPush({
      userId: bid.supplier.userId,
      title: 'Bid accepted — acknowledge to start',
      body: 'Consumer accepted your bid. Acknowledge to create the order.',
      data: { bidId: bid.id },
    });

    res.json({
      bidId: bid.id,
      bindOnAccept: true,
      message: 'Accept is binding. Both parties must acknowledge to create order.',
    });
  },
);

bidzoneRouter.post('/consumer/bids/:id/reject', authenticate, requireRole('consumer'), async (req, res) => {
  const bid = assertFound(
    await prisma.bid.findUnique({
      where: { id: requireParam(req, 'id') },
      include: { bidRequest: { include: { consumer: true } } },
    }),
  );
  if (bid.bidRequest.consumer.userId !== req.user!.id) {
    throw new AppError(403, 'FORBIDDEN', 'Not your request');
  }
  const updated = await prisma.bid.update({ where: { id: bid.id }, data: { status: 'rejected' } });
  emitAuction(bid.bidRequestId, 'auction.bid_rejected', { bidId: bid.id });
  res.json({ bid: updated });
});

const ackSchema = z.object({ role: z.enum(['consumer', 'supplier']) });

bidzoneRouter.post(
  '/bids/:id/acknowledge',
  authenticate,
  validateBody(ackSchema),
  async (req, res) => {
    const bid = assertFound(
      await prisma.bid.findUnique({
        where: { id: requireParam(req, 'id') },
        include: {
          bidRequest: { include: { consumer: true, items: true } },
          supplier: true,
          order: true,
        },
      }),
    );
    if (bid.status !== 'accepted') throw new AppError(400, 'NOT_ACCEPTED', 'Bid must be accepted first');

    const role = req.body.role as 'consumer' | 'supplier';
    if (role === 'consumer') {
      if (req.user!.id !== bid.bidRequest.consumer.userId) {
        throw new AppError(403, 'FORBIDDEN', 'Not consumer');
      }
      await prisma.bid.update({ where: { id: bid.id }, data: { consumerAckAt: new Date() } });
    } else {
      if (req.user!.id !== bid.supplier.userId) throw new AppError(403, 'FORBIDDEN', 'Not supplier');
      await prisma.bid.update({ where: { id: bid.id }, data: { supplierAckAt: new Date() } });
    }

    const refreshed = await prisma.bid.findUnique({
      where: { id: bid.id },
      include: {
        bidRequest: { include: { consumer: true, items: true } },
        supplier: true,
        order: true,
      },
    });

    if (refreshed?.consumerAckAt && refreshed.supplierAckAt && !refreshed.order) {
      const order = await createOrderFromAcceptedBid(refreshed.id);
      emitAuction(bid.bidRequestId, 'order.created', { orderId: order.id });
      return res.json({ acknowledged: true, order });
    }

    res.json({ acknowledged: true, awaiting: !refreshed?.consumerAckAt ? 'consumer' : 'supplier' });
  },
);

/** Public-ish supplier performance for bid cards */
bidzoneRouter.get('/suppliers/:id/performance', authenticate, async (req, res) => {
  const profile = assertFound(
    await prisma.supplierProfile.findUnique({
      where: { id: requireParam(req, 'id') },
      select: {
        id: true,
        publicLabel: true,
        rating: true,
        onTimeRate: true,
        returnRate: true,
        challanAdjustRate: true,
        responseTimeSec: true,
        kycStatus: true,
      },
    }),
  );
  res.json({ performance: profile });
});
