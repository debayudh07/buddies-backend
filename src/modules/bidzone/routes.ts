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
  const userId = req.user!.id;
  const profile = await prisma.supplierProfile.findUnique({ where: { userId } });

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setHours(0, 0, 0, 0);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

  const [
    openCount,
    activeOrders,
    completedOrders,
    activeBids,
    acceptedBids,
    rejectedBids,
    withdrawnBids,
    ordersByStatusRaw,
    recentOrders,
    recentBids,
    bidCap,
  ] = await Promise.all([
    prisma.bidRequest.count({ where: { status: 'open', liveEndsAt: { gt: new Date() } } }),
    prisma.order.count({
      where: {
        supplierUserId: userId,
        status: { in: ['preparing', 'out_for_delivery', 'arrived', 'inspection_pending', 'bid_accepted'] },
      },
    }),
    prisma.order.count({
      where: { supplierUserId: userId, status: { in: ['delivered', 'closed', 'challan_signed'] } },
    }),
    profile ? prisma.bid.count({ where: { supplierId: profile.id, status: 'active' } }) : Promise.resolve(0),
    profile ? prisma.bid.count({ where: { supplierId: profile.id, status: 'accepted' } }) : Promise.resolve(0),
    profile ? prisma.bid.count({ where: { supplierId: profile.id, status: 'rejected' } }) : Promise.resolve(0),
    profile ? prisma.bid.count({ where: { supplierId: profile.id, status: 'withdrawn' } }) : Promise.resolve(0),
    prisma.order.groupBy({
      by: ['status'],
      where: { supplierUserId: userId },
      _count: { _all: true },
    }),
    prisma.order.findMany({
      where: { supplierUserId: userId, createdAt: { gte: sevenDaysAgo } },
      select: { createdAt: true },
    }),
    profile
      ? prisma.bid.findMany({
          where: { supplierId: profile.id, createdAt: { gte: sevenDaysAgo } },
          select: { createdAt: true },
        })
      : Promise.resolve([] as { createdAt: Date }[]),
    getSupplierBidCap(userId),
  ]);

  const dayKeys: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(sevenDaysAgo);
    d.setDate(sevenDaysAgo.getDate() + i);
    dayKeys.push(d.toISOString().slice(0, 10));
  }
  const bidsByDay = Object.fromEntries(dayKeys.map((k) => [k, 0]));
  const ordersByDay = Object.fromEntries(dayKeys.map((k) => [k, 0]));
  for (const b of recentBids) {
    const k = b.createdAt.toISOString().slice(0, 10);
    if (k in bidsByDay) bidsByDay[k] = (bidsByDay[k] ?? 0) + 1;
  }
  for (const o of recentOrders) {
    const k = o.createdAt.toISOString().slice(0, 10);
    if (k in ordersByDay) ordersByDay[k] = (ordersByDay[k] ?? 0) + 1;
  }

  const ordersByStatus = ordersByStatusRaw
    .map((r) => ({ status: r.status, count: r._count._all }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);

  res.json({
    kycStatus: profile?.kycStatus ?? 'draft',
    openBidzoneCount: openCount,
    activeOrders,
    activeBids,
    completedOrders,
    bidQuota: {
      cap: bidCap,
      used: activeBids,
      remaining: Math.max(0, bidCap - activeBids),
    },
    performance: profile
      ? {
          rating: profile.rating,
          onTimeRate: profile.onTimeRate,
          returnRate: profile.returnRate,
          challanAdjustRate: profile.challanAdjustRate,
        }
      : null,
    charts: {
      ordersByStatus,
      bidsByOutcome: [
        { label: 'Active', value: activeBids },
        { label: 'Won', value: acceptedBids },
        { label: 'Lost', value: rejectedBids },
        { label: 'Withdrawn', value: withdrawnBids },
      ].filter((x) => x.value > 0),
      activity7d: dayKeys.map((date) => ({
        date,
        bids: bidsByDay[date],
        orders: ordersByDay[date],
      })),
    },
  });
});

bidzoneRouter.get('/supplier/bidzone', authenticate, requireRole('supplier'), async (req, res) => {
  // Browse is open to all suppliers; placing a bid still requires verified KYC.
  const profile = await prisma.supplierProfile.findUnique({
    where: { userId: req.user!.id },
    select: { id: true, lat: true, lng: true, kycStatus: true },
  });
  const [bidCap, activeBidCount] = await Promise.all([
    getSupplierBidCap(req.user!.id),
    profile
      ? prisma.bid.count({ where: { supplierId: profile.id, status: 'active' } })
      : Promise.resolve(0),
  ]);
  const now = new Date();
  const requests = await prisma.bidRequest.findMany({
    where: { status: 'open', liveEndsAt: { gt: now } },
    select: {
      id: true,
      batchCode: true,
      budgetPaise: true,
      liveEndsAt: true,
      extendCount: true,
      lat: true,
      lng: true,
      items: {
        select: {
          id: true,
          name: true,
          quantity: true,
          unit: true,
          productCategory: true,
          gradeHint: true,
        },
      },
      bids: {
        where: { status: 'active' },
        orderBy: { amountPaise: 'asc' },
        take: 1,
        select: { amountPaise: true, supplierId: true },
      },
    },
    orderBy: { liveEndsAt: 'asc' },
    take: 50,
  });

  const feed = requests.map((r: (typeof requests)[number]) => {
    let distanceKm: number | null = null;
    if (profile?.lat != null && profile?.lng != null && r.lat != null && r.lng != null) {
      distanceKm = Math.round(haversineKm(profile.lat, profile.lng, r.lat, r.lng) * 10) / 10;
    }
    const best = r.bids[0] ?? null;
    // Use live config so staging tweaks apply to in-flight auctions too.
    const minDecrementPaise = config.auction.minDecrementPaise;
    const maxBidPaise =
      best != null ? best.amountPaise - minDecrementPaise : null;
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
      bestBidPaise: best?.amountPaise ?? null,
      minDecrementPaise,
      maxBidPaise,
    };
  });

  const remaining = Math.max(0, bidCap - activeBidCount);
  res.json({
    feed,
    kycStatus: profile?.kycStatus ?? 'draft',
    canBid: profile?.kycStatus === 'verified' && remaining > 0,
    bidQuota: {
      cap: bidCap,
      used: activeBidCount,
      remaining,
    },
  });
});

const placeBidSchema = z.object({
  bidRequestId: z.string().min(1),
  amountPaise: z.coerce.number().int().positive(),
  grade: z.string().min(1).default('A'),
  // Defaults keep older clients working; supplier UI should still send these.
  shelfLifeDays: z.coerce.number().int().positive().default(7),
  rslDaysAtDelivery: z.coerce.number().int().nonnegative().default(3),
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
    const minDecrementPaise = config.auction.minDecrementPaise;
    if (best && body.amountPaise > best.amountPaise - minDecrementPaise) {
      // First bid is free; later bids (from others) must undercut by min decrement.
      // Same supplier may update their own leading bid freely.
      if (best.supplierId !== profile.id) {
        const maxPaise = best.amountPaise - minDecrementPaise;
        const maxRupees = (maxPaise / 100).toFixed(0);
        const bestRupees = (best.amountPaise / 100).toFixed(0);
        const cutRupees = (minDecrementPaise / 100).toFixed(0);
        throw new AppError(
          400,
          'MIN_DECREMENT',
          `Bid at most ₹${maxRupees} — current best is ₹${bestRupees} (min undercut ₹${cutRupees})`,
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
      void sendPush({
        userId: consumer.userId,
        title: 'New bid',
        body: `${profile.publicLabel} bid ₹${(body.amountPaise / 100).toFixed(0)}`,
        data: { bidRequestId: bidRequest.id, bidId: bid.id },
      }).catch(() => undefined);
    }

    res.status(201).json({ bid, liveEndsAt, extendCount });
  },
);

bidzoneRouter.get('/supplier/bids', authenticate, requireRole('supplier'), async (req, res) => {
  const profile = await prisma.supplierProfile.findUnique({ where: { userId: req.user!.id } });
  if (!profile) return res.json({ bids: [] });
  const take = Math.min(
    Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1),
    100,
  );
  const bids = await prisma.bid.findMany({
    where: { supplierId: profile.id },
    include: {
      bidRequest: {
        include: {
          items: true,
          consumer: {
            select: { restaurantName: true, city: true, lat: true, lng: true },
          },
          bids: {
            where: { status: { in: ['active', 'accepted'] } },
            select: { id: true, amountPaise: true, status: true },
            orderBy: { amountPaise: 'asc' },
            take: 25,
          },
        },
      },
      order: { select: { id: true, orderCode: true, status: true } },
    },
    orderBy: { createdAt: 'desc' },
    take,
  });

  const enriched = bids.map((b) => {
    const peerBids = b.bidRequest.bids;
    const competing = peerBids.filter((x) => x.id !== b.id);
    const bestOther = competing[0]?.amountPaise ?? null;
    const sortedAsc = [...peerBids].sort((a, c) => a.amountPaise - c.amountPaise);
    const bidRank = Math.max(1, sortedAsc.findIndex((x) => x.id === b.id) + 1);
    const isLeading =
      b.status === 'active' && (bestOther == null || b.amountPaise <= bestOther);

    const reqLat = b.bidRequest.lat ?? b.bidRequest.consumer.lat;
    const reqLng = b.bidRequest.lng ?? b.bidRequest.consumer.lng;
    let distanceKm = b.distanceKm;
    if (
      distanceKm == null &&
      profile.lat != null &&
      profile.lng != null &&
      reqLat != null &&
      reqLng != null
    ) {
      distanceKm = Math.round(haversineKm(profile.lat, profile.lng, reqLat, reqLng) * 10) / 10;
    }

    const city = b.bidRequest.consumer.city?.trim() || null;
    const restaurant = b.bidRequest.consumer.restaurantName?.trim() || null;
    const locationHint =
      b.status === 'accepted' || b.order
        ? [restaurant, city].filter(Boolean).join(', ') ||
          (distanceKm != null ? `~${distanceKm} km away` : 'Delivery location pending')
        : city
          ? distanceKm != null
            ? `${city} · ~${distanceKm} km`
            : city
          : distanceKm != null
            ? `~${distanceKm} km away`
            : 'Nearby';

    const items = b.bidRequest.items.map((it) => ({
      id: it.id,
      name: it.name,
      quantity: it.quantity,
      unit: it.unit,
      productCategory: it.productCategory,
      gradeHint: it.gradeHint,
    }));
    const itemSummary =
      items.length === 0
        ? 'No items listed'
        : items
            .map((it) => `${it.name} × ${it.quantity}${it.unit ? ` ${it.unit}` : ''}`)
            .join(', ');

    const needsSupplierAck = b.status === 'accepted' && !b.supplierAckAt;
    const waitingConsumerAck =
      b.status === 'accepted' && !!b.supplierAckAt && !b.consumerAckAt && !b.order;
    let statusHint = '';
    switch (b.status) {
      case 'active':
        statusHint = isLeading
          ? 'You are the lowest bid — waiting for the consumer to choose.'
          : bestOther != null
            ? `Another bid is lower (₹${Math.round(bestOther / 100)}). Auction still open.`
            : 'Auction open — waiting for the consumer to choose.';
        break;
      case 'accepted':
        if (b.order) {
          statusHint = needsSupplierAck
            ? `You won — order ${b.order.orderCode} is open. Confirm you received it (optional), then start preparing.`
            : `Won — order ${b.order.orderCode} · ${b.order.status}.`;
        } else if (needsSupplierAck) {
          statusHint = 'You won — order is open; confirm receipt is optional.';
        } else if (waitingConsumerAck) {
          statusHint = 'You confirmed — waiting for the consumer (legacy).';
        } else {
          statusHint = 'Accepted — order is open (bind-on-accept).';
        }
        break;
      case 'rejected':
        statusHint = 'Consumer chose another supplier.';
        break;
      case 'withdrawn':
        statusHint = 'You withdrew this bid.';
        break;
      case 'expired':
        statusHint = 'Auction ended without your bid winning.';
        break;
      default:
        statusHint = b.status;
    }

    const { bids: _peerBids, consumer: _consumer, ...bidRequestRest } = b.bidRequest;

    return {
      id: b.id,
      bidRequestId: b.bidRequestId,
      amountPaise: b.amountPaise,
      grade: b.grade,
      shelfLifeDays: b.shelfLifeDays,
      rslDaysAtDelivery: b.rslDaysAtDelivery,
      notes: b.notes,
      status: b.status,
      statusHint,
      score: b.score,
      distanceKm,
      locationHint,
      consumerAckAt: b.consumerAckAt,
      supplierAckAt: b.supplierAckAt,
      acceptedAt: b.acceptedAt,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      batchCode: b.bidRequest.batchCode,
      requestStatus: b.bidRequest.status,
      budgetPaise: b.bidRequest.budgetPaise,
      liveEndsAt: b.bidRequest.liveEndsAt,
      deliveryWindow: b.bidRequest.deliveryWindow,
      durationHours: b.bidRequest.durationHours,
      items,
      itemSummary,
      competingBidCount: competing.length,
      totalBidsOnRequest: peerBids.length,
      bestCompetingPaise: bestOther,
      bidRank,
      isLeading,
      needsSupplierAck,
      waitingConsumerAck,
      order: b.order,
      orderId: b.order?.id ?? null,
      bidRequest: {
        ...bidRequestRest,
        items,
        locationHint,
      },
    };
  });

  res.json({ bids: enriched });
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

/** Consumer: list scored bids (owner of RFQ only) */
bidzoneRouter.get(
  '/consumer/bid-requests/:id/bids',
  authenticate,
  requireRole('consumer'),
  async (req, res) => {
    const bidRequestId = requireParam(req, 'id');
    const bidRequest = assertFound(
      await prisma.bidRequest.findUnique({
        where: { id: bidRequestId },
        include: { consumer: { select: { userId: true } } },
      }),
    );
    if (bidRequest.consumer.userId !== req.user!.id && req.user!.role !== 'admin') {
      throw new AppError(403, 'FORBIDDEN', 'Not your bid request');
    }

    const bids = await prisma.bid.findMany({
      where: {
        bidRequestId,
        status: { in: ['active', 'accepted'] },
      },
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
        order: { select: { id: true, orderCode: true, status: true } },
      },
      orderBy: { score: 'desc' },
    });
    res.json({ bids });
  },
);

/** Bind-on-accept — creates order atomically with status flip */
bidzoneRouter.post(
  '/consumer/bids/:id/accept',
  authenticate,
  requireRole('consumer'),
  async (req, res) => {
    const bidId = requireParam(req, 'id');
    const bid = assertFound(
      await prisma.bid.findUnique({
        where: { id: bidId },
        include: { bidRequest: { include: { consumer: true } }, supplier: true },
      }),
    );
    if (bid.bidRequest.consumer.userId !== req.user!.id) {
      throw new AppError(403, 'FORBIDDEN', 'Not your request');
    }
    if (bid.status !== 'active') throw new AppError(400, 'INVALID_STATE', 'Bid not active');
    if (bid.bidRequest.status !== 'open') throw new AppError(400, 'NOT_OPEN', 'Already awarded');

    // Single transaction: award + reject peers (order create next under race-safe path)
    try {
      await prisma.$transaction(async (tx) => {
        const current = await tx.bidRequest.findUnique({
          where: { id: bid.bidRequestId },
          select: { status: true },
        });
        if (!current || current.status !== 'open') {
          throw new AppError(400, 'NOT_OPEN', 'Already awarded');
        }
        const live = await tx.bid.findUnique({ where: { id: bid.id }, select: { status: true } });
        if (!live || live.status !== 'active') {
          throw new AppError(400, 'INVALID_STATE', 'Bid not active');
        }
        await tx.bid.update({
          where: { id: bid.id },
          data: {
            status: 'accepted',
            acceptedAt: new Date(),
            consumerAckAt: new Date(),
          },
        });
        await tx.bid.updateMany({
          where: { bidRequestId: bid.bidRequestId, id: { not: bid.id }, status: 'active' },
          data: { status: 'rejected' },
        });
        await tx.bidRequest.update({
          where: { id: bid.bidRequestId },
          data: { status: 'awarded', winningBidId: bid.id },
        });
      });
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw e;
    }

    const order = await createOrderFromAcceptedBid(bid.id);

    emitAuction(bid.bidRequestId, 'auction.bid_accepted', { bidId: bid.id });
    emitAuction(bid.bidRequestId, 'order.created', { orderId: order.id });
    await sendPush({
      userId: bid.supplier.userId,
      title: 'You won the bid',
      body: `Order ${order.orderCode} is ready — open it to chat and start preparing.`,
      data: { bidId: bid.id, orderId: order.id },
    });

    res.json({
      bidId: bid.id,
      orderId: order.id,
      order,
      bindOnAccept: true,
      message: 'Bid accepted. Order created — chat and tracking are available.',
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
  if (bid.status !== 'active') {
    throw new AppError(400, 'INVALID_STATE', 'Only active bids can be rejected');
  }
  if (bid.bidRequest.status !== 'open') {
    throw new AppError(400, 'NOT_OPEN', 'Auction is no longer open');
  }
  const updated = await prisma.bid.update({ where: { id: bid.id }, data: { status: 'rejected' } });
  emitAuction(bid.bidRequestId, 'auction.bid_rejected', { bidId: bid.id });
  res.json({ bid: updated });
});

const ackSchema = z.object({ role: z.enum(['consumer', 'supplier']) });

/**
 * Optional party ack timestamps. Order is already created on consumer accept (bind-on-accept).
 * Supplier ack is informational only and never blocks fulfillment.
 */
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

    // Legacy safety: rare pre-bind drafts — create order if consumer ack exists without order.
    if (refreshed?.consumerAckAt && !refreshed.order) {
      const order = await createOrderFromAcceptedBid(refreshed.id);
      emitAuction(bid.bidRequestId, 'order.created', { orderId: order.id });
      return res.json({
        acknowledged: true,
        order,
        bindOnAccept: false,
        note: 'Order created from legacy dual-ack path',
      });
    }

    if (refreshed?.order && role === 'supplier' && refreshed.supplierAckAt) {
      await prisma.order.update({
        where: { id: refreshed.order.id },
        data: { supplierAckAt: refreshed.supplierAckAt },
      });
    }

    res.json({
      acknowledged: true,
      order: refreshed?.order ?? undefined,
      // Informational only — fulfillment is never blocked on supplier ack.
      supplierAckOptional: true,
    });
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
