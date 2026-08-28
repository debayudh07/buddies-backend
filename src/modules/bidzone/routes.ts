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
import { emitAuction, emitUser } from '../../socket';
import { sendPush } from '../../lib/notify';
import { createOrderFromAcceptedBid, emitOrderChatCreated } from '../orders/service';
import { shelfRulesForItems } from '../../lib/product-categories';
import { quantityInUnit, type CatalogUnit } from '../../lib/product-catalog';
import { publicSupplierLabel } from '../../lib/user-present';
import { cacheGet, cacheSet, invalidateBidzoneFeeds, invalidateSupplierLists, invalidateConsumerLists } from '../../lib/response-cache';

export const bidzoneRouter = Router();

/** Prisma filter: status active and past bid TTL not elapsed. */
function activeUnexpiredWhere(now = new Date()) {
  return {
    status: 'active' as const,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

function computeBidExpiresAt(auctionLiveEndsAt: Date, from = new Date()): Date {
  const ttlEnd = new Date(from.getTime() + config.auction.bidTtlSec * 1000);
  return ttlEnd.getTime() < auctionLiveEndsAt.getTime() ? ttlEnd : auctionLiveEndsAt;
}

function isBidStillLive(bid: {
  status: string;
  expiresAt?: Date | null;
}): boolean {
  if (bid.status !== 'active') return false;
  if (bid.expiresAt && bid.expiresAt.getTime() <= Date.now()) return false;
  return true;
}

/** Mirror an order onto both user rooms so My Bids / Orders lists upsert without auction join. */
function emitOrderCreatedToParties(order: {
  id: string;
  status: string;
  consumerUserId: string;
  supplierUserId: string;
}) {
  const payload = {
    orderId: order.id,
    status: order.status,
    paymentStatus: null as string | null,
    reason: null as string | null,
    at: Date.now(),
  };
  emitUser(order.consumerUserId, 'order.created', payload);
  emitUser(order.supplierUserId, 'order.created', payload);
  emitUser(order.consumerUserId, 'order.updated', payload);
  emitUser(order.supplierUserId, 'order.updated', payload);
}

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
    profile
      ? prisma.bid.count({
          where: { supplierId: profile.id, ...activeUnexpiredWhere() },
        })
      : Promise.resolve(0),
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
  const cacheKey = `bidzone:feed:${req.user!.id}`;
  const cached = await cacheGet<Record<string, unknown>>(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    res.json(cached);
    return;
  }
  // Browse is open to all suppliers; placing a bid still requires verified KYC.
  const profile = await prisma.supplierProfile.findUnique({
    where: { userId: req.user!.id },
    select: { id: true, lat: true, lng: true, kycStatus: true, categories: true },
  });
  const [bidCap, activeBidCount] = await Promise.all([
    getSupplierBidCap(req.user!.id),
    profile
      ? prisma.bid.count({
          where: { supplierId: profile.id, ...activeUnexpiredWhere() },
        })
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
          catalogCategory: true,
          catalogItemSlug: true,
          minimumOrderQty: true,
          minimumOrderUnit: true,
          status: true,
        },
      },
      bids: {
        where: activeUnexpiredWhere(now),
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
      shelfRules: shelfRulesForItems(r.items),
      distanceKm,
      // Masked — no consumer address / restaurant name
      locationHint: distanceKm != null ? `~${distanceKm} km away` : 'Nearby',
      bestBidPaise: best?.amountPaise ?? null,
      minDecrementPaise,
      maxBidPaise,
    };
  });

  const remaining = Math.max(0, bidCap - activeBidCount);
  const payload = {
    feed,
    kycStatus: profile?.kycStatus ?? 'draft',
    canBid: profile?.kycStatus === 'verified' && remaining > 0,
    bidQuota: {
      cap: bidCap,
      used: activeBidCount,
      remaining,
    },
    categories: profile?.categories ?? [],
  };
  await cacheSet(cacheKey, payload, 8_000);
  res.setHeader('X-Cache', 'MISS');
  res.json(payload);
});

const placeBidSchema = z.object({
  bidRequestId: z.string().min(1),
  amountPaise: z.coerce.number().int().positive().optional(),
  grade: z.string().min(1).default('A'),
  // Defaults keep older clients working; supplier UI should still send category-aware values.
  shelfLifeDays: z.coerce.number().int().positive().default(5),
  rslDaysAtDelivery: z.coerce.number().int().nonnegative().default(2),
  notes: z.string().optional(),
  lines: z.array(z.object({
    bidRequestItemId: z.string().min(1),
    amountPaise: z.coerce.number().int().positive(),
    notes: z.string().optional(),
  })).optional(),
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
      where: { supplierId: profile.id, ...activeUnexpiredWhere() },
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
    if (body.rslDaysAtDelivery > body.shelfLifeDays) {
      throw new AppError(
        400,
        'RSL_EXCEEDS_SHELF',
        'Remaining shelf life (RSL) cannot exceed total shelf life',
      );
    }

    const lines = body.lines || [];
    const isItemized = lines.length > 0;

    if (!body.amountPaise && !isItemized) {
      throw new AppError(400, 'AMOUNT_OR_LINES_REQUIRED', 'Either amountPaise or per-item lines must be provided');
    }

    if (isItemized) {
      const ids = lines.map((l) => l.bidRequestItemId);
      if (new Set(ids).size !== ids.length) {
        throw new AppError(400, 'DUPLICATE_LINE', 'Each item can appear only once in a bid');
      }
      const reqItemIds = bidRequest.items.map((i) => i.id);
      for (const line of lines) {
        if (!reqItemIds.includes(line.bidRequestItemId)) {
          throw new AppError(400, 'INVALID_ITEM_ID', `Item ${line.bidRequestItemId} is not in the bid request`);
        }
      }
    }

    const bidAmountPaise = isItemized
      ? lines.reduce((sum, l) => sum + l.amountPaise, 0)
      : body.amountPaise!;
    const coveredItemIds = isItemized
      ? lines.map((l) => l.bidRequestItemId)
      : [];
    const isPartial = isItemized && coveredItemIds.length < bidRequest.items.length;

    const coveredItems = isItemized
      ? bidRequest.items.filter((i) => coveredItemIds.includes(i.id))
      : bidRequest.items;

    for (const item of coveredItems) {
      if (item.minimumOrderQty == null || !item.minimumOrderUnit) continue;
      const from = (item.unit as CatalogUnit) || 'kg';
      const to = item.minimumOrderUnit as CatalogUnit;
      const qty = quantityInUnit(item.quantity, from, to);
      if (qty != null && qty + 1e-9 < item.minimumOrderQty) {
        throw new AppError(
          400,
          'MOQ_BELOW_MINIMUM',
          `Requested quantity for ${item.name} is below the ${item.minimumOrderQty} ${item.minimumOrderUnit} minimum`,
        );
      }
    }

    // Enforce product-doc Minimum RSL matrix for items this bid covers.
    const rules = shelfRulesForItems(coveredItems);
    if (body.rslDaysAtDelivery < rules.minRslDays) {
      throw new AppError(
        400,
        'RSL_BELOW_MATRIX',
        `Minimum RSL for the covered items is ${rules.minRslDays} day(s) at delivery (category matrix). You entered ${body.rslDaysAtDelivery}.`,
      );
    }
    if (body.shelfLifeDays < rules.minRslDays) {
      throw new AppError(
        400,
        'SHELF_BELOW_MATRIX',
        `Total shelf life must be at least ${rules.minRslDays} day(s) for the covered items.`,
      );
    }

    const minDecrementPaise = config.auction.minDecrementPaise;

    if (isItemized) {
      for (const line of lines) {
        const bestLine = await prisma.bidLineItem.findFirst({
          where: {
            bidRequestItemId: line.bidRequestItemId,
            bid: activeUnexpiredWhere(),
          },
          orderBy: { amountPaise: 'asc' },
          include: { bid: true },
        });

        if (bestLine && line.amountPaise > bestLine.amountPaise - minDecrementPaise) {
          if (bestLine.bid.supplierId !== profile.id) {
            const maxPaise = bestLine.amountPaise - minDecrementPaise;
            const maxRupees = (maxPaise / 100).toFixed(0);
            const bestRupees = (bestLine.amountPaise / 100).toFixed(0);
            const cutRupees = (minDecrementPaise / 100).toFixed(0);
            const itemName = bidRequest.items.find((i) => i.id === line.bidRequestItemId)?.name || 'Item';
            throw new AppError(
              400,
              'MIN_DECREMENT',
              `Bid at most ₹${maxRupees} for ${itemName} — current best is ₹${bestRupees} (min undercut ₹${cutRupees})`,
            );
          }
        }
      }
    } else {
      const best = await prisma.bid.findFirst({
        where: { bidRequestId: bidRequest.id, ...activeUnexpiredWhere() },
        orderBy: { amountPaise: 'asc' },
      });
      if (best && bidAmountPaise > best.amountPaise - minDecrementPaise) {
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
    }

    let proRatedBudgetPaise = bidRequest.budgetPaise;
    if (isItemized && bidRequest.budgetPaise != null) {
      const totalQty = bidRequest.items.reduce((sum, i) => sum + i.quantity, 0);
      const coveredQty = bidRequest.items
        .filter((i) => coveredItemIds.includes(i.id))
        .reduce((sum, i) => sum + i.quantity, 0);
      
      proRatedBudgetPaise = totalQty > 0
        ? Math.round((bidRequest.budgetPaise * coveredQty) / totalQty)
        : 0;
    }

    let distanceKm = 5;
    if (profile.lat != null && profile.lng != null && bidRequest.lat != null && bidRequest.lng != null) {
      distanceKm = haversineKm(profile.lat, profile.lng, bidRequest.lat, bidRequest.lng);
    }

    const { score, breakdown } = computeBidScore({
      amountPaise: bidAmountPaise,
      budgetPaise: proRatedBudgetPaise,
      rslDays: body.rslDaysAtDelivery,
      minRslDays: rules.minRslDays,
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

    const bidExpiresAt = computeBidExpiresAt(liveEndsAt);

    const bid = await prisma.$transaction(async (tx) => {
      await tx.bid.updateMany({
        where: {
          bidRequestId: bidRequest.id,
          supplierId: profile.id,
          status: 'active',
        },
        data: { status: 'withdrawn' },
      });

      const createdBid = await tx.bid.create({
        data: {
          bidRequestId: bidRequest.id,
          supplierId: profile.id,
          amountPaise: bidAmountPaise,
          grade: body.grade,
          shelfLifeDays: body.shelfLifeDays,
          rslDaysAtDelivery: body.rslDaysAtDelivery,
          notes: body.notes,
          score,
          scoreBreakdown: breakdown,
          distanceKm,
          expiresAt: bidExpiresAt,
          coveredItemIds,
          isPartial,
        },
        include: {
          supplier: {
            select: { publicLabel: true, rating: true, onTimeRate: true, returnRate: true },
          },
        },
      });

      if (isItemized) {
        await tx.bidLineItem.createMany({
          data: lines.map((l) => ({
            bidId: createdBid.id,
            bidRequestItemId: l.bidRequestItemId,
            amountPaise: l.amountPaise,
            notes: l.notes || null,
          })),
        });
      }

      return tx.bid.findUniqueOrThrow({
        where: { id: createdBid.id },
        include: {
          supplier: {
            select: { publicLabel: true, rating: true, onTimeRate: true, returnRate: true },
          },
          bidLines: true,
        },
      });
    });

    emitAuction(bidRequest.id, 'auction.bid_placed', {
      bid,
      liveEndsAt,
      extendCount,
      bidExpiresAt,
      bidTtlSec: config.auction.bidTtlSec,
    });
    emitUser(profile.userId, 'bid.status_changed', {
      bidId: bid.id,
      status: 'active',
      bidRequestId: bidRequest.id,
    });

    const consumer = await prisma.consumerProfile.findUnique({ where: { id: bidRequest.consumerId } });
    await Promise.all([
      invalidateBidzoneFeeds(),
      invalidateSupplierLists(profile.userId),
      consumer ? invalidateConsumerLists(consumer.userId) : Promise.resolve(),
    ]);
    if (consumer) {
      void sendPush({
        userId: consumer.userId,
        title: 'New bid',
        body: `${publicSupplierLabel(profile)} bid ₹${(bidAmountPaise / 100).toFixed(0)} (active ${Math.round(config.auction.bidTtlSec / 60)} min)`,
        data: { bidRequestId: bidRequest.id, bidId: bid.id },
      }).catch(() => undefined);
    }

    res.status(201).json({
      bid,
      liveEndsAt,
      extendCount,
      bidExpiresAt,
      bidTtlSec: config.auction.bidTtlSec,
    });
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
            where: {
              OR: [
                { status: 'accepted' },
                activeUnexpiredWhere(),
              ],
            },
            select: { id: true, amountPaise: true, status: true, expiresAt: true },
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
    const peerBids = b.bidRequest.bids.filter(
      (x) => x.status === 'accepted' || isBidStillLive(x),
    );
    const competing = peerBids.filter((x) => x.id !== b.id);
    const bestOther = competing[0]?.amountPaise ?? null;
    const sortedAsc = [...peerBids].sort((a, c) => a.amountPaise - c.amountPaise);
    const bidRank = Math.max(1, sortedAsc.findIndex((x) => x.id === b.id) + 1);
    const stillLive = isBidStillLive(b);
    const isLeading =
      stillLive && (bestOther == null || b.amountPaise <= bestOther);

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
    const ttlMin = Math.max(1, Math.round(config.auction.bidTtlSec / 60));
    switch (b.status) {
      case 'active':
        if (!stillLive) {
          statusHint = `This bid expired after ${ttlMin} minute${ttlMin === 1 ? '' : 's'}. Place a new bid if the auction is still open.`;
        } else {
          statusHint = isLeading
            ? `Leading bid — live for up to ${ttlMin} min. Waiting for the consumer.`
            : bestOther != null
              ? `Another bid is lower (₹${Math.round(bestOther / 100)}). Your bid stays live up to ${ttlMin} min.`
              : `Auction open — your bid stays live up to ${ttlMin} min.`;
        }
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
        statusHint = `Bid expired (max ${ttlMin} min active) or auction closed without your bid winning.`;
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
      status: stillLive ? b.status : b.status === 'active' ? 'expired' : b.status,
      statusHint,
      score: b.score,
      distanceKm,
      locationHint,
      consumerAckAt: b.consumerAckAt,
      supplierAckAt: b.supplierAckAt,
      acceptedAt: b.acceptedAt,
      expiresAt: b.expiresAt,
      bidTtlSec: config.auction.bidTtlSec,
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
  if (!isBidStillLive(bid)) throw new AppError(400, 'INVALID_STATE', 'Bid not active or expired');
  const updated = await prisma.bid.update({
    where: { id: bid.id },
    data: { status: 'withdrawn' },
  });
  emitAuction(bid.bidRequestId, 'auction.bid_withdrawn', { bidId: bid.id });
  emitUser(profile.userId, 'bid.status_changed', {
    bidId: bid.id,
    status: 'withdrawn',
    bidRequestId: bid.bidRequestId,
  });
  await Promise.all([
    invalidateBidzoneFeeds(),
    invalidateSupplierLists(profile.userId),
  ]);
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
        include: { consumer: { select: { userId: true } }, items: true },
      }),
    );
    if (bidRequest.consumer.userId !== req.user!.id && req.user!.role !== 'admin') {
      throw new AppError(403, 'FORBIDDEN', 'Not your bid request');
    }

    const bids = await prisma.bid.findMany({
      where: {
        bidRequestId,
        OR: [{ status: 'accepted' }, activeUnexpiredWhere()],
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
          },
        },
        order: { select: { id: true, orderCode: true, status: true } },
        bidLines: true,
      },
      orderBy: { score: 'desc' },
    });

    const itemId = req.query.itemId as string | undefined;
    const sort = req.query.sort as string | undefined; // price | score | rating | coverage
    const statusParam = req.query.status as string | undefined; // active | accepted | all

    let filteredBids = bids;

    // 1. Filter by status
    if (statusParam === 'active') {
      filteredBids = filteredBids.filter((b) => b.status === 'active' && isBidStillLive(b));
    } else if (statusParam === 'accepted') {
      filteredBids = filteredBids.filter((b) => b.status === 'accepted');
    }

    // 2. Filter by itemId
    if (itemId) {
      filteredBids = filteredBids.filter((b) => {
        if (b.bidLines.length > 0) {
          return b.bidLines.some((l) => l.bidRequestItemId === itemId);
        }
        if (b.coveredItemIds.length === 0) return true;
        return b.coveredItemIds.includes(itemId);
      });
    }

    // 3. Sort
    if (sort === 'price') {
      filteredBids.sort((a, b) => {
        if (itemId) {
          const priceA = a.bidLines.find((l) => l.bidRequestItemId === itemId)?.amountPaise ?? a.amountPaise;
          const priceB = b.bidLines.find((l) => l.bidRequestItemId === itemId)?.amountPaise ?? b.amountPaise;
          return priceA - priceB;
        }
        return a.amountPaise - b.amountPaise;
      });
    } else if (sort === 'rating') {
      filteredBids.sort((a, b) => b.supplier.rating - a.supplier.rating);
    } else if (sort === 'coverage') {
      const totalItems = bidRequest.items.length;
      const getCoverage = (b: typeof bids[number]) => {
        if (b.coveredItemIds.length === 0) return 1.0;
        return totalItems > 0 ? b.coveredItemIds.length / totalItems : 0;
      };
      filteredBids.sort((a, b) => getCoverage(b) - getCoverage(a));
    } else {
      filteredBids.sort((a, b) => b.score - a.score);
    }

    res.json({
      bids: filteredBids.map((b) => ({
        ...b,
        supplier: b.supplier
          ? { ...b.supplier, publicLabel: publicSupplierLabel(b.supplier) }
          : b.supplier,
      })),
      bidTtlSec: config.auction.bidTtlSec,
    });
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
    if (!isBidStillLive(bid)) {
      throw new AppError(
        400,
        'BID_EXPIRED',
        `This bid is no longer active (max ${Math.round(config.auction.bidTtlSec / 60)} minutes). Ask the supplier to rebid.`,
      );
    }
    if (bid.bidRequest.status !== 'open') throw new AppError(400, 'NOT_OPEN', 'Already awarded');

    // Single transaction: award + reject peers if fully awarded (order create next under race-safe path)
    try {
      await prisma.$transaction(async (tx) => {
        const current = await tx.bidRequest.findUnique({
          where: { id: bid.bidRequestId },
          select: { status: true },
        });
        if (!current || current.status !== 'open') {
          throw new AppError(400, 'NOT_OPEN', 'Already awarded');
        }
        const live = await tx.bid.findUnique({
          where: { id: bid.id },
          select: { status: true, expiresAt: true, coveredItemIds: true },
        });
        if (!live || !isBidStillLive(live)) {
          throw new AppError(400, 'BID_EXPIRED', 'Bid not active');
        }

        // Fetch items status to verify not already awarded
        const reqItems = await tx.bidRequestItem.findMany({
          where: { bidRequestId: bid.bidRequestId },
        });
        const coveredIds = live.coveredItemIds.length > 0
          ? live.coveredItemIds
          : reqItems.map((i) => i.id);

        const alreadyAwarded = reqItems.filter(
          (i) => coveredIds.includes(i.id) && i.status === 'awarded'
        );
        if (alreadyAwarded.length > 0) {
          const names = alreadyAwarded.map((i) => i.name).join(', ');
          throw new AppError(
            400,
            'ALREADY_AWARDED',
            `The following items are already awarded: ${names}`
          );
        }

        // Award items
        await tx.bidRequestItem.updateMany({
          where: { id: { in: coveredIds } },
          data: { status: 'awarded' },
        });

        // Mark bid as accepted
        await tx.bid.update({
          where: { id: bid.id },
          data: {
            status: 'accepted',
            acceptedAt: new Date(),
            consumerAckAt: new Date(),
          },
        });

        // Check if all items are now awarded
        const allItems = await tx.bidRequestItem.findMany({
          where: { bidRequestId: bid.bidRequestId },
        });
        const allAwarded = allItems.every((i) => i.status === 'awarded');

        if (allAwarded) {
          await tx.bidRequest.update({
            where: { id: bid.bidRequestId },
            data: { status: 'awarded', winningBidId: bid.id },
          });

          // Reject remaining active bids
          await tx.bid.updateMany({
            where: {
              bidRequestId: bid.bidRequestId,
              status: 'active',
            },
            data: { status: 'rejected' },
          });
        }
      });
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw e;
    }

    const order = await createOrderFromAcceptedBid(bid.id);

    emitAuction(bid.bidRequestId, 'auction.bid_accepted', { bidId: bid.id });
    emitAuction(bid.bidRequestId, 'order.created', { orderId: order.id });
    emitOrderCreatedToParties(order);
    emitUser(bid.supplier.userId, 'bid.status_changed', {
      bidId: bid.id,
      status: 'accepted',
      orderId: order.id,
    });
    emitUser(bid.bidRequest.consumer.userId, 'bidRequest.updated', {
      id: bid.bidRequestId,
      status: 'awarded',
      orderId: order.id,
    });
    await sendPush({
      userId: bid.supplier.userId,
      title: 'You won the bid',
      body: `Order ${order.orderCode} is ready — open it to chat and start preparing.`,
      data: { bidId: bid.id, orderId: order.id },
    });

    await Promise.all([
      invalidateBidzoneFeeds(),
      invalidateSupplierLists(bid.supplier.userId),
      invalidateConsumerLists(bid.bidRequest.consumer.userId),
    ]);

    res.json({
      bidId: bid.id,
      orderId: order.id,
      order,
      bindOnAccept: true,
      message: 'Bid accepted. Order created — chat and tracking are available.',
    });
  },
);

const awardPlanSchema = z.object({
  selections: z
    .array(
      z.object({
        bidRequestItemId: z.string().min(1),
        bidId: z.string().min(1),
      }),
    )
    .min(1),
});

/**
 * Atomic split award: one live itemized bid per open item, then one order per winning supplier.
 */
bidzoneRouter.post(
  '/consumer/bid-requests/:id/award-plan',
  authenticate,
  requireRole('consumer'),
  validateBody(awardPlanSchema),
  async (req, res) => {
    const bidRequestId = requireParam(req, 'id');
    const { selections } = req.body as z.infer<typeof awardPlanSchema>;
    const bidRequest = assertFound(
      await prisma.bidRequest.findUnique({
        where: { id: bidRequestId },
        include: { consumer: true, items: true },
      }),
    );
    if (bidRequest.consumer.userId !== req.user!.id) {
      throw new AppError(403, 'FORBIDDEN', 'Not your request');
    }
    if (bidRequest.status !== 'open') {
      throw new AppError(400, 'NOT_OPEN', 'Request is no longer open');
    }

    const selectedItemIds = selections.map((s) => s.bidRequestItemId);
    if (new Set(selectedItemIds).size !== selectedItemIds.length) {
      throw new AppError(400, 'DUPLICATE_ITEM', 'Each item can have only one winner');
    }

    const openItems = bidRequest.items.filter((i) => i.status === 'open');
    if (openItems.length === 0) {
      throw new AppError(400, 'NOTHING_TO_AWARD', 'All items are already awarded');
    }
    const openIds = new Set(openItems.map((i) => i.id));
    if (selectedItemIds.length !== openItems.length || selectedItemIds.some((id) => !openIds.has(id))) {
      throw new AppError(
        400,
        'INCOMPLETE_SELECTION',
        'Select exactly one winning bid for every remaining item',
      );
    }

    const bidIds = [...new Set(selections.map((s) => s.bidId))];
    const bids = await prisma.bid.findMany({
      where: { id: { in: bidIds }, bidRequestId },
      include: { bidLines: true, supplier: true },
    });
    if (bids.length !== bidIds.length) {
      throw new AppError(400, 'BID_NOT_FOUND', 'One or more selected bids were not found');
    }

    const bidById = new Map(bids.map((b) => [b.id, b]));
    const bySupplier = new Map<
      string,
      { bidId: string; supplierUserId: string; itemIds: string[] }
    >();
    for (const sel of selections) {
      const b = bidById.get(sel.bidId)!;
      if (!isBidStillLive(b) && b.status !== 'accepted') {
        throw new AppError(400, 'BID_EXPIRED', 'A selected bid is no longer live');
      }
      const itemized = b.bidLines.length > 0 || b.coveredItemIds.length > 0;
      if (!itemized) {
        throw new AppError(
          400,
          'NOT_ITEMIZED',
          'Split awards require itemized bids. Use Accept on a full-basket offer, or ask the supplier to rebid per item.',
        );
      }
      const covers =
        b.coveredItemIds.length === 0 && b.bidLines.length === 0
          ? bidRequest.items.map((i) => i.id)
          : b.coveredItemIds.length > 0
            ? b.coveredItemIds
            : b.bidLines.map((l) => l.bidRequestItemId);
      if (!covers.includes(sel.bidRequestItemId)) {
        throw new AppError(400, 'ITEM_NOT_COVERED', 'Selected bid does not cover that item');
      }
      const grouped = bySupplier.get(b.supplierId);
      if (!grouped) {
        bySupplier.set(b.supplierId, {
          bidId: b.id,
          supplierUserId: b.supplier.userId,
          itemIds: [sel.bidRequestItemId],
        });
      } else {
        if (grouped.bidId !== b.id) {
          throw new AppError(
            400,
            'CONFLICTING_SELECTION',
            'A supplier can win through only one bid on this request',
          );
        }
        grouped.itemIds.push(sel.bidRequestItemId);
      }
    }

    const orders = await prisma.$transaction(async (tx) => {
      const current = await tx.bidRequest.findUnique({
        where: { id: bidRequestId },
        select: { status: true },
      });
      if (!current || current.status !== 'open') {
        throw new AppError(400, 'NOT_OPEN', 'Already awarded');
      }

      const liveItems = await tx.bidRequestItem.findMany({ where: { bidRequestId } });
      for (const sel of selections) {
        const item = liveItems.find((i) => i.id === sel.bidRequestItemId);
        if (!item || item.status === 'awarded') {
          throw new AppError(400, 'ALREADY_AWARDED', 'An item was awarded concurrently');
        }
      }

      for (const sel of selections) {
        await tx.bidRequestItem.update({
          where: { id: sel.bidRequestItemId },
          data: { status: 'awarded', awardedBidId: sel.bidId },
        });
      }

      await tx.bid.updateMany({
        where: { id: { in: bidIds } },
        data: {
          status: 'accepted',
          acceptedAt: new Date(),
          consumerAckAt: new Date(),
        },
      });

      await tx.bid.updateMany({
        where: {
          bidRequestId,
          status: 'active',
          id: { notIn: bidIds },
        },
        data: { status: 'rejected' },
      });

      await tx.bidRequest.update({
        where: { id: bidRequestId },
        data: { status: 'awarded', winningBidId: bidIds[0] },
      });

      const created = [];
      for (const group of bySupplier.values()) {
        const order = await createOrderFromAcceptedBid(group.bidId, {
          coveredItemIds: group.itemIds,
          tx,
          emitRealtime: false,
        });
        created.push(order);
      }
      return created;
    }, { timeout: 20000 });

    for (const order of orders) {
      emitOrderChatCreated(order);
      emitAuction(bidRequestId, 'order.created', { orderId: order.id });
      emitOrderCreatedToParties(order);
      const winner = [...bidById.values()].find((b) => b.id === order.bidId);
      if (winner) {
        await sendPush({
          userId: winner.supplier.userId,
          title: 'You won items',
          body: `Order ${order.orderCode} is ready — open it to chat and start preparing.`,
          data: { bidId: order.bidId, orderId: order.id },
        });
      }
    }

    emitAuction(bidRequestId, 'auction.bid_accepted', { bidIds });
    emitUser(bidRequest.consumer.userId, 'bidRequest.updated', {
      id: bidRequestId,
      status: 'awarded',
    });
    for (const winner of bidById.values()) {
      emitUser(winner.supplier.userId, 'bid.status_changed', {
        bidId: winner.id,
        status: 'accepted',
      });
    }

    await Promise.all([
      invalidateBidzoneFeeds(),
      invalidateConsumerLists(bidRequest.consumer.userId),
      ...[...bidById.values()].map((w) => invalidateSupplierLists(w.supplier.userId)),
    ]);

    res.json({
      bidIds,
      orders,
      bindOnAccept: true,
      message: `Awarded to ${orders.length} supplier${orders.length === 1 ? '' : 's'}.`,
    });
  },
);

bidzoneRouter.post('/consumer/bids/:id/reject', authenticate, requireRole('consumer'), async (req, res) => {
  const bid = assertFound(
    await prisma.bid.findUnique({
      where: { id: requireParam(req, 'id') },
      include: { bidRequest: { include: { consumer: true } }, supplier: true },
    }),
  );
  if (bid.bidRequest.consumer.userId !== req.user!.id) {
    throw new AppError(403, 'FORBIDDEN', 'Not your request');
  }
  if (!isBidStillLive(bid)) {
    throw new AppError(400, 'INVALID_STATE', 'Only active (non-expired) bids can be rejected');
  }
  if (bid.bidRequest.status !== 'open') {
    throw new AppError(400, 'NOT_OPEN', 'Auction is no longer open');
  }
  const updated = await prisma.bid.update({ where: { id: bid.id }, data: { status: 'rejected' } });
  emitAuction(bid.bidRequestId, 'auction.bid_rejected', { bidId: bid.id });
  emitUser(bid.supplier.userId, 'bid.status_changed', {
    bidId: bid.id,
    status: 'rejected',
  });
  await Promise.all([
    invalidateBidzoneFeeds(),
    invalidateSupplierLists(bid.supplier.userId),
    invalidateConsumerLists(req.user!.id),
  ]);
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
      emitOrderCreatedToParties(order);
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
  res.json({
    performance: {
      ...profile,
      publicLabel: publicSupplierLabel(profile),
    },
  });
});
