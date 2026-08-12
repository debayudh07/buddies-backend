import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { authenticate, requireRole } from '../../middleware/auth';
import { requireParam } from '../../middleware/params';
import { validateBody } from '../../middleware/validate';
import { AppError, assertFound } from '../../lib/errors';
import { config } from '../../config';
import { emitTracking, emitUser } from '../../socket';
import { sendPush } from '../../lib/notify';
import { updateSupplierPerformanceOnDelivery } from './service';
import { etaMinutes, haversineKm } from '../../lib/haversine';
import { redisGet, redisSet } from '../../lib/redis';
import { buildInvoicePdf } from '../../lib/invoice-pdf';
import { parseLimit } from '../../lib/pagination';
import {
  responseCacheGet,
  responseCacheInvalidate,
  responseCacheSet,
} from '../../lib/response-cache';
import {
  consumerPublicRating,
  ewmaRating,
  ewmaTrustFromStars,
  supplierPublicRating,
} from '../../lib/ratings';

export const ordersRouter = Router();

const ORDER_DETAIL_TTL_MS = 15_000;
const CHALLAN_TTL_MS = 15_000;

function invalidateOrderCaches(orderId: string) {
  responseCacheInvalidate(`order:detail:${orderId}:`);
  responseCacheInvalidate(`order:challan:${orderId}:`);
}

type OrderStatus =
  | 'bid_accepted'
  | 'preparing'
  | 'out_for_delivery'
  | 'arrived'
  | 'inspection_pending'
  | 'rejected_on_spot'
  | 'delivered'
  | 'challan_signed'
  | 'closed'
  | 'cancelled';

/** Linear rank for fulfillment — higher = later. Missing ranks are null. */
const STATUS_RANK: Partial<Record<OrderStatus, number>> = {
  bid_accepted: 0,
  preparing: 1,
  out_for_delivery: 2,
  arrived: 3,
  inspection_pending: 3,
  delivered: 4,
  challan_signed: 4,
  closed: 5,
};

/**
 * Broadcast order change to:
 * - tracking:{orderId} (order detail screens join this)
 * - user:{consumer|supplier} (list/home can refresh like chat inbox)
 */
function notifyOrderUpdated(
  order: { id: string; status: string; consumerUserId: string; supplierUserId: string },
  opts: {
    paymentStatus?: string | null;
    reason?: string;
    push?: { userId: string; title: string; body: string };
  } = {},
) {
  const payload = {
    orderId: order.id,
    status: order.status,
    paymentStatus: opts.paymentStatus ?? null,
    reason: opts.reason ?? null,
    at: Date.now(),
  };
  emitTracking(order.id, 'order.status_changed', payload);
  emitTracking(order.id, 'order.updated', payload);
  emitUser(order.consumerUserId, 'order.updated', payload);
  emitUser(order.supplierUserId, 'order.updated', payload);
  invalidateOrderCaches(order.id);
  if (opts.push) {
    void sendPush({
      userId: opts.push.userId,
      title: opts.push.title,
      body: opts.push.body,
      data: { orderId: order.id, status: order.status },
    }).catch(() => undefined);
  }
}

/** True when the requested status step was already applied (safe double-tap). */
function statusAlreadyApplied(current: OrderStatus, next: OrderStatus): boolean {
  if (current === next) return true;
  // arrived auto-becomes inspection_pending
  if (
    next === 'arrived' &&
    ['arrived', 'inspection_pending', 'delivered', 'challan_signed', 'closed'].includes(current)
  ) {
    return true;
  }
  const cr = STATUS_RANK[current];
  const nr = STATUS_RANK[next];
  if (cr == null || nr == null) return false;
  return cr >= nr && nr > 0;
}

/** ACL-only order row — mutations / tracking / payment (no heavy joins). */
async function assertOrderAccess(orderId: string, userId: string, role: string) {
  const order = assertFound(await prisma.order.findUnique({ where: { id: orderId } }));
  if (role !== 'admin' && order.consumerUserId !== userId && order.supplierUserId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Not your order');
  }
  return order;
}

/** Full detail payload for GET /orders/:id — lean selects (cuts Prisma multi-join cost). */
async function getOrderForUser(orderId: string, userId: string, role: string) {
  const order = assertFound(
    await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderCode: true,
        status: true,
        consumerUserId: true,
        supplierUserId: true,
        deliveryLat: true,
        deliveryLng: true,
        deliveryAddress: true,
        deliveredAt: true,
        createdAt: true,
        updatedAt: true,
        bid: {
          select: {
            id: true,
            amountPaise: true,
            grade: true,
            rslDaysAtDelivery: true,
            supplier: {
              select: {
                id: true,
                publicLabel: true,
                rating: true,
                ratingCount: true,
                onTimeRate: true,
                returnRate: true,
                challanAdjustRate: true,
              },
            },
          },
        },
        bidRequest: {
          select: {
            id: true,
            deliveryWindow: true,
            deliveryAddress: true,
            budgetPaise: true,
            items: {
              select: {
                name: true,
                quantity: true,
                unit: true,
                productCategory: true,
              },
            },
          },
        },
        digitalChallan: {
          select: {
            id: true,
            orderId: true,
            isDraft: true,
            signedAt: true,
            lineSnapshotJson: true,
            createdAt: true,
          },
        },
        offlinePayment: true,
        gstInvoice: {
          select: { id: true, invoiceNumber: true },
        },
        chatThread: { select: { id: true, orderId: true } },
        trackingSession: {
          select: { id: true, active: true, lastPointAt: true, startedAt: true },
        },
        statusEvents: {
          orderBy: { createdAt: 'asc' },
          take: 40,
          select: { id: true, status: true, note: true, createdAt: true },
        },
        ratings: {
          select: {
            id: true,
            fromUserId: true,
            toUserId: true,
            fromRole: true,
            stars: true,
            comment: true,
            createdAt: true,
          },
        },
      },
    }),
  );
  if (role !== 'admin' && order.consumerUserId !== userId && order.supplierUserId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Not your order');
  }
  return order;
}

const listOrderInclude = {
  offlinePayment: { select: { status: true, id: true } },
  trackingSession: { select: { id: true, active: true, lastPointAt: true } },
  bid: { select: { amountPaise: true, grade: true } },
  bidRequest: {
    select: {
      deliveryWindow: true,
      deliveryAddress: true,
      items: {
        select: {
          name: true,
          quantity: true,
          unit: true,
          productCategory: true,
        },
        take: 8,
      },
    },
  },
} as const;

/** Flatten fields the Flutter apps expect (totalPaise, items, delivery helpers). */
function presentOrder<T extends {
  deliveryLat?: number | null;
  deliveryLng?: number | null;
  deliveryAddress?: string | null;
  bid?: { amountPaise?: number; grade?: string; rslDaysAtDelivery?: number } | null;
  bidRequest?: {
    deliveryWindow?: string | null;
    deliveryAddress?: string | null;
    items?: Array<{
      name: string;
      quantity: number;
      unit: string;
      productCategory: string | null;
    }>;
  } | null;
  digitalChallan?: { lineSnapshotJson?: unknown } | null;
}>(order: T) {
  const totalPaise = order.bid?.amountPaise ?? 0;
  const items =
    order.bidRequest?.items?.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      qty: i.quantity,
      unit: i.unit,
      productCategory: i.productCategory,
    })) ?? [];
  const hasDeliveryPin =
    typeof order.deliveryLat === 'number' && typeof order.deliveryLng === 'number';
  return {
    ...order,
    totalPaise,
    items,
    deliveryWindow: order.bidRequest?.deliveryWindow ?? null,
    hasDeliveryPin,
  };
}

ordersRouter.get('/consumer/orders', authenticate, requireRole('consumer'), async (req, res) => {
  const take = parseLimit(req.query.limit, { defaultLimit: 20, max: 50 });
  const orders = await prisma.order.findMany({
    where: { consumerUserId: req.user!.id },
    orderBy: { createdAt: 'desc' },
    take,
    include: listOrderInclude,
  });
  res.json({ orders: orders.map(presentOrder) });
});

ordersRouter.get('/supplier/orders', authenticate, requireRole('supplier'), async (req, res) => {
  const take = parseLimit(req.query.limit, { defaultLimit: 20, max: 50 });
  const orders = await prisma.order.findMany({
    where: { supplierUserId: req.user!.id },
    orderBy: { createdAt: 'desc' },
    take,
    include: listOrderInclude,
  });
  res.json({ orders: orders.map(presentOrder) });
});

ordersRouter.get('/orders/:id', authenticate, async (req, res) => {
  const id = requireParam(req, 'id');
  const cacheKey = `order:detail:${id}:${req.user!.id}`;
  const cached = responseCacheGet<Record<string, unknown>>(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    res.json(cached);
    return;
  }
  const order = await getOrderForUser(id, req.user!.id, req.user!.role);
  const base = presentOrder(order);
  const enriched = await enrichOrderWithRatings(base, req.user!.id);
  const payload = { order: enriched };
  responseCacheSet(cacheKey, payload, ORDER_DETAIL_TTL_MS);
  res.setHeader('X-Cache', 'MISS');
  res.json(payload);
});

type RatingRow = {
  id: string;
  fromUserId: string;
  toUserId: string;
  fromRole: string;
  stars: number;
  comment: string | null;
  createdAt: Date;
};

function presentRating(r: RatingRow) {
  // Stars/comment/role only — no user IDs in client payloads.
  return {
    id: r.id,
    fromRole: r.fromRole,
    stars: r.stars,
    comment: r.comment,
    createdAt: r.createdAt,
  };
}

async function enrichOrderWithRatings<
  T extends {
    id: string;
    status: string;
    consumerUserId: string;
    supplierUserId: string;
    ratings?: RatingRow[];
    bid?: {
      supplier?: {
        rating?: number;
        ratingCount?: number;
        onTimeRate?: number;
        returnRate?: number;
        challanAdjustRate?: number;
      } | null;
    } | null;
  },
>(order: T, viewerUserId: string) {
  const ratings = order.ratings ?? [];
  const my = ratings.find((r) => r.fromUserId === viewerUserId) ?? null;
  const peer = ratings.find((r) => r.fromUserId !== viewerUserId) ?? null;

  const [supplierProfile, consumerProfile] = await Promise.all([
    prisma.supplierProfile.findUnique({
      where: { userId: order.supplierUserId },
      select: {
        rating: true,
        ratingCount: true,
        onTimeRate: true,
        returnRate: true,
        challanAdjustRate: true,
      },
    }),
    prisma.consumerProfile.findUnique({
      where: { userId: order.consumerUserId },
      select: { rating: true, ratingCount: true, trustScore: true },
    }),
  ]);

  const supplierPublic = supplierProfile
    ? supplierPublicRating(supplierProfile)
    : { displayed: 5, perfStars: 5, avgPeerStars: null, ratingCount: 0 };
  const consumerPublic = consumerProfile
    ? consumerPublicRating(consumerProfile)
    : { displayed: 5, perfStars: 5, avgPeerStars: null, ratingCount: 0 };

  const canRate = order.status === 'closed' && !my;

  const { ratings: _drop, ...rest } = order as T & { ratings?: RatingRow[] };
  return {
    ...rest,
    myRating: my ? presentRating(my) : null,
    peerRating: peer ? presentRating(peer) : null,
    canRate,
    supplierPublicRating: supplierPublic,
    consumerPublicRating: consumerPublic,
  };
}

const statusSchema = z.object({
  status: z.enum(['preparing', 'out_for_delivery', 'arrived']),
  note: z.string().optional(),
});

ordersRouter.post(
  '/orders/:id/status',
  authenticate,
  requireRole('supplier'),
  validateBody(statusSchema),
  async (req, res) => {
    const order = await assertOrderAccess(requireParam(req, 'id'), req.user!.id, 'supplier');
    const next = req.body.status as OrderStatus;
    const currentStatus = order.status as OrderStatus;

    if (statusAlreadyApplied(currentStatus, next)) {
      const fresh = await getOrderForUser(order.id, req.user!.id, 'supplier');
      res.json({ order: presentOrder(fresh), alreadyApplied: true });
      return;
    }

    const allowed: Partial<Record<OrderStatus, OrderStatus[]>> = {
      bid_accepted: ['preparing'],
      preparing: ['out_for_delivery'],
      out_for_delivery: ['arrived'],
      arrived: [],
    };
    const ok = allowed[currentStatus]?.includes(next);
    if (!ok) {
      throw new AppError(400, 'INVALID_TRANSITION', `Cannot go from ${currentStatus} to ${next}`);
    }

    const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const o = await tx.order.update({
        where: { id: order.id },
        data: { status: next as never },
      });
      await tx.orderStatusEvent.create({
        data: { orderId: order.id, status: next as never, note: req.body.note },
      });

      if (next === 'out_for_delivery') {
        await tx.trackingSession.upsert({
          where: { orderId: order.id },
          create: { orderId: order.id, active: true },
          update: { active: true, startedAt: new Date(), endedAt: null },
        });
      }
      if (next === 'arrived') {
        await tx.trackingSession.updateMany({
          where: { orderId: order.id },
          data: { active: false, endedAt: new Date() },
        });
        // Arrived immediately opens doorstep inspection — consumer can sign challan.
        const inspection = await tx.order.update({
          where: { id: order.id },
          data: {
            status: 'inspection_pending',
            inspectionEndsAt: new Date(Date.now() + config.inspectionWindowSec * 1000),
          },
        });
        await tx.orderStatusEvent.create({
          data: {
            orderId: order.id,
            status: 'inspection_pending',
            note: 'Supplier arrived — consumer can inspect and sign the digital challan',
          },
        });
        return inspection;
      }
      return o;
    });

    const fresh = await getOrderForUser(order.id, req.user!.id, 'supplier');
    const effectiveStatus = (fresh as { status?: string })?.status ?? updated.status;

    notifyOrderUpdated(
      {
        id: order.id,
        status: effectiveStatus,
        consumerUserId: order.consumerUserId,
        supplierUserId: order.supplierUserId,
      },
      {
        reason: `status:${next}`,
        push: {
          userId: order.consumerUserId,
          title: next === 'arrived' ? 'Supplier arrived — sign challan' : 'Order update',
          body:
            next === 'arrived'
              ? 'Inspect goods at the door and sign the digital challan to confirm delivery.'
              : `Status: ${effectiveStatus}`,
        },
      },
    );

    res.json({ order: presentOrder(fresh) });
  },
);

/** Automated GPS stream point */
ordersRouter.post(
  '/orders/:id/tracking',
  authenticate,
  requireRole('supplier'),
  validateBody(
    z.object({
      lat: z.number(),
      lng: z.number(),
      heading: z.number().optional(),
      speed: z.number().optional(),
      recordedAt: z.string().datetime().optional(),
    }),
  ),
  async (req, res) => {
    const order = await assertOrderAccess(requireParam(req, 'id'), req.user!.id, 'supplier');
    const session = await prisma.trackingSession.findUnique({ where: { orderId: order.id } });
    if (!session?.active) throw new AppError(400, 'NO_TRACKING_SESSION', 'Start out_for_delivery first');

    const point = await prisma.trackingPoint.create({
      data: {
        orderId: order.id,
        lat: req.body.lat,
        lng: req.body.lng,
        heading: req.body.heading,
        speed: req.body.speed,
        recordedAt: req.body.recordedAt ? new Date(req.body.recordedAt) : new Date(),
      },
    });
    await prisma.trackingSession.update({
      where: { orderId: order.id },
      data: { lastPointAt: point.recordedAt },
    });

    let etaMin: number | null = null;
    if (order.deliveryLat != null && order.deliveryLng != null) {
      const d = haversineKm(point.lat, point.lng, order.deliveryLat, order.deliveryLng);
      etaMin = etaMinutes(d);
    }

    emitTracking(order.id, 'tracking.location_updated', { point, etaMinutes: etaMin });

    await redisSet(
      `tracking:last:${order.id}`,
      JSON.stringify({ point, etaMinutes: etaMin }),
      300,
    );

    res.status(201).json({ point, etaMinutes: etaMin });
  },
);

ordersRouter.get('/orders/:id/tracking/live', authenticate, async (req, res) => {
  const order = await assertOrderAccess(requireParam(req, 'id'), req.user!.id, req.user!.role);

  const cached = await redisGet(`tracking:last:${order.id}`);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { point: unknown; etaMinutes: number | null };
      const session = await prisma.trackingSession.findUnique({ where: { orderId: order.id } });
      return res.json({
        session,
        latest: parsed.point,
        etaMinutes: parsed.etaMinutes,
        source: 'redis',
      });
    } catch {
      /* fall through */
    }
  }

  const latest = await prisma.trackingPoint.findFirst({
    where: { orderId: order.id },
    orderBy: { recordedAt: 'desc' },
  });
  const session = await prisma.trackingSession.findUnique({ where: { orderId: order.id } });
  let etaMin: number | null = null;
  if (latest && order.deliveryLat != null && order.deliveryLng != null) {
    etaMin = etaMinutes(haversineKm(latest.lat, latest.lng, order.deliveryLat, order.deliveryLng));
  }
  res.json({ session, latest, etaMinutes: etaMin, source: 'db' });
});

ordersRouter.post('/orders/:id/inspection/start', authenticate, requireRole('consumer'), async (req, res) => {
  const order = await assertOrderAccess(requireParam(req, 'id'), req.user!.id, 'consumer');

  // Already in inspection / past doorstep → idempotent.
  if (order.status === 'inspection_pending') {
    res.json({
      order,
      inspectionWindowSec: config.inspectionWindowSec,
      alreadyApplied: true,
    });
    return;
  }
  if (['delivered', 'challan_signed', 'closed', 'rejected_on_spot'].includes(order.status)) {
    res.json({
      order,
      inspectionWindowSec: config.inspectionWindowSec,
      alreadyApplied: true,
    });
    return;
  }
  if (!['arrived', 'out_for_delivery'].includes(order.status)) {
    throw new AppError(400, 'INVALID_STATE', 'Order not at doorstep');
  }
  const updated = await prisma.order.update({
    where: { id: order.id },
    data: {
      status: 'inspection_pending',
      inspectionEndsAt: new Date(Date.now() + config.inspectionWindowSec * 1000),
    },
    include: { digitalChallan: true },
  });
  notifyOrderUpdated(
    {
      id: order.id,
      status: updated.status,
      consumerUserId: order.consumerUserId,
      supplierUserId: order.supplierUserId,
    },
    { reason: 'inspection_start' },
  );
  res.json({ order: updated, inspectionWindowSec: config.inspectionWindowSec });
});

ordersRouter.post(
  '/orders/:id/inspection/adjust-qty',
  authenticate,
  requireRole('supplier'),
  validateBody(z.object({ lineSnapshotJson: z.array(z.record(z.any())) })),
  async (req, res) => {
    const order = await assertOrderAccess(requireParam(req, 'id'), req.user!.id, 'supplier');
    const existingChallan = await prisma.digitalChallan.findUnique({ where: { orderId: order.id } });
    if (existingChallan && !existingChallan.isDraft) {
      // Idempotent read of already-signed challan
      res.json({ challan: existingChallan, alreadySigned: true });
      return;
    }
    const challan = await prisma.digitalChallan.upsert({
      where: { orderId: order.id },
      create: {
        orderId: order.id,
        isDraft: true,
        lineSnapshotJson: req.body.lineSnapshotJson,
      },
      update: { lineSnapshotJson: req.body.lineSnapshotJson },
    });

    const profile = await prisma.supplierProfile.findUnique({ where: { userId: req.user!.id } });
    if (profile) {
      const alpha = 0.1;
      await prisma.supplierProfile.update({
        where: { id: profile.id },
        data: { challanAdjustRate: profile.challanAdjustRate * (1 - alpha) + 100 * alpha },
      });
    }

    invalidateOrderCaches(order.id);
    emitTracking(order.id, 'order.updated', {
      orderId: order.id,
      status: order.status,
      reason: 'challan_adjusted',
      at: Date.now(),
    });

    res.json({ challan });
  },
);

ordersRouter.post(
  '/orders/:id/inspection/reject-on-spot',
  authenticate,
  requireRole('consumer'),
  validateBody(z.object({ reason: z.string(), mediaRef: z.string().optional() })),
  async (req, res) => {
    const order = await assertOrderAccess(requireParam(req, 'id'), req.user!.id, 'consumer');

    if (order.status === 'rejected_on_spot') {
      res.json({ order, alreadyApplied: true });
      return;
    }

    if (!['arrived', 'inspection_pending'].includes(order.status)) {
      throw new AppError(
        400,
        'INVALID_STATE',
        'Reject on spot only at doorstep (after supplier marks arrived)',
      );
    }
    const existingChallan = await prisma.digitalChallan.findUnique({ where: { orderId: order.id } });
    if (existingChallan && !existingChallan.isDraft) {
      throw new AppError(400, 'CHALLAN_ALREADY_SIGNED', 'Already signed');
    }
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { status: 'rejected_on_spot' },
    });
    await prisma.orderStatusEvent.create({
      data: {
        orderId: order.id,
        status: 'rejected_on_spot',
        note: req.body.reason,
      },
    });
    await prisma.digitalChallan.updateMany({
      where: { orderId: order.id },
      data: { isDraft: true },
    });
    notifyOrderUpdated(
      {
        id: order.id,
        status: updated.status,
        consumerUserId: order.consumerUserId,
        supplierUserId: order.supplierUserId,
      },
      {
        reason: 'reject_on_spot',
        push: {
          userId: order.supplierUserId,
          title: 'Rejected on spot',
          body: req.body.reason,
        },
      },
    );
    res.json({ order: updated });
  },
);

ordersRouter.post(
  '/orders/:id/inspection/sign-challan',
  authenticate,
  requireRole('consumer'),
  validateBody(z.object({ signatureRef: z.string().optional() })),
  async (req, res) => {
    const order = await assertOrderAccess(requireParam(req, 'id'), req.user!.id, 'consumer');

    // Idempotent: first tap already delivered the order — return existing signed state.
    if (['delivered', 'challan_signed', 'closed'].includes(order.status)) {
      const [challan, invoice] = await Promise.all([
        prisma.digitalChallan.findUnique({ where: { orderId: order.id } }),
        prisma.gstInvoice.findUnique({ where: { orderId: order.id } }),
      ]);
      if (challan && !challan.isDraft) {
        res.json({ order, challan, invoice, alreadySigned: true });
        return;
      }
    }

    if (!['arrived', 'inspection_pending'].includes(order.status)) {
      throw new AppError(
        400,
        'INVALID_STATE',
        `Sign challan only at doorstep (arrived / inspection). Current status: ${order.status}`,
      );
    }

    const onTime = !order.slaDeadlineAt || new Date() <= order.slaDeadlineAt;
    const draftChallan = await prisma.digitalChallan.findUnique({ where: { orderId: order.id } });

    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const challan = await tx.digitalChallan.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id,
          isDraft: false,
          signedAt: new Date(),
          signedByUserId: req.user!.id,
          signatureRef: req.body.signatureRef,
          lineSnapshotJson: draftChallan?.lineSnapshotJson ?? [],
        },
        update: {
          isDraft: false,
          signedAt: new Date(),
          signedByUserId: req.user!.id,
          signatureRef: req.body.signatureRef,
        },
      });

      const o = await tx.order.update({
        where: { id: order.id },
        data: {
          status: 'delivered',
          deliveredAt: new Date(),
          slaStatus: onTime ? 'met' : 'breached',
        },
      });
      await tx.orderStatusEvent.create({
        data: { orderId: order.id, status: 'delivered', note: 'Digital challan signed' },
      });
      await tx.trackingSession.updateMany({
        where: { orderId: order.id },
        data: { active: false, endedAt: new Date() },
      });

      // GST invoice from challan (skip if a concurrent request already created it)
      const invNum = `INV-${o.orderCode}`;
      const invoice = await tx.gstInvoice.upsert({
        where: { orderId: o.id },
        create: {
          orderId: o.id,
          invoiceNumber: invNum,
          lineJson: challan.lineSnapshotJson as object,
        },
        update: {},
      });

      return { order: o, challan, invoice };
    });

    await updateSupplierPerformanceOnDelivery(order.supplierUserId, onTime);
    notifyOrderUpdated(
      {
        id: order.id,
        status: result.order.status,
        consumerUserId: order.consumerUserId,
        supplierUserId: order.supplierUserId,
      },
      {
        reason: 'sign_challan',
        push: {
          userId: order.supplierUserId,
          title: 'Challan signed — delivered',
          body: 'Consumer signed digital challan. Offline payment can start.',
        },
      },
    );

    res.json(result);
  },
);

ordersRouter.get('/orders/:id/challan', authenticate, async (req, res) => {
  const orderId = requireParam(req, 'id');
  const cacheKey = `order:challan:${orderId}:${req.user!.id}`;
  const cached = responseCacheGet<Record<string, unknown>>(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    res.json(cached);
    return;
  }

  // ACL + fields needed for challan only — not full order detail tree.
  const order = assertFound(
    await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderCode: true,
        consumerUserId: true,
        supplierUserId: true,
        bid: {
          select: { amountPaise: true, grade: true, rslDaysAtDelivery: true },
        },
        bidRequest: {
          select: {
            items: {
              select: {
                name: true,
                quantity: true,
                unit: true,
                productCategory: true,
              },
            },
          },
        },
        digitalChallan: true,
      },
    }),
  );
  if (
    req.user!.role !== 'admin' &&
    order.consumerUserId !== req.user!.id &&
    order.supplierUserId !== req.user!.id
  ) {
    throw new AppError(403, 'FORBIDDEN', 'Not your order');
  }

  const amountPaise = order.bid?.amountPaise ?? 0;

  let challan = order.digitalChallan;
  if (!challan) {
    const lines =
      order.bidRequest?.items?.map((i, idx, arr) => ({
        name: i.name,
        quantity: i.quantity,
        unit: i.unit,
        productCategory: i.productCategory,
        grade: order.bid?.grade,
        rslDaysAtDelivery: order.bid?.rslDaysAtDelivery,
        amountPaise: idx === 0 ? amountPaise : 0,
        lineTotalPaise: idx === 0 ? amountPaise : 0,
        isWinningBidTotal: idx === 0,
        itemCount: arr.length,
      })) ??
      [
        {
          name: 'Winning bid',
          quantity: 1,
          unit: 'lot',
          amountPaise,
          lineTotalPaise: amountPaise,
          isWinningBidTotal: true,
        },
      ];

    challan = await prisma.digitalChallan.create({
      data: {
        orderId: order.id,
        isDraft: true,
        lineSnapshotJson: lines,
      },
    });
    responseCacheInvalidate(`order:detail:${orderId}:`);
  }

  const lines = Array.isArray(challan.lineSnapshotJson)
    ? (challan.lineSnapshotJson as Record<string, unknown>[])
    : [];

  const payload = {
    challan: {
      ...challan,
      amountPaise,
      orderCode: order.orderCode,
      lines,
      totalPaise: amountPaise,
    },
    amountPaise,
    orderCode: order.orderCode,
  };
  responseCacheSet(cacheKey, payload, CHALLAN_TTL_MS);
  res.setHeader('X-Cache', 'MISS');
  res.json(payload);
});

async function loadInvoiceBundle(orderId: string, userId: string, role: string) {
  const order = await getOrderForUser(orderId, userId, role);
  let invoice = await prisma.gstInvoice.findUnique({ where: { orderId: order.id } });

  // Backfill invoice if challan was signed but invoice row is missing.
  if (!invoice && (order.status === 'delivered' || order.status === 'challan_signed' || order.status === 'closed')) {
    const challan = order.digitalChallan;
    invoice = await prisma.gstInvoice.create({
      data: {
        orderId: order.id,
        invoiceNumber: `INV-${order.orderCode}`,
        lineJson: (challan?.lineSnapshotJson as object) ?? [],
      },
    });
  }

  if (!invoice) {
    throw new AppError(404, 'NO_INVOICE', 'Invoice not generated yet — sign challan first');
  }

  const supplier = await prisma.supplierProfile.findUnique({
    where: { userId: order.supplierUserId },
    select: { publicLabel: true, businessName: true },
  });
  const consumer = await prisma.consumerProfile.findUnique({
    where: { userId: order.consumerUserId },
    select: { restaurantName: true },
  });

  const amountPaise = order.bid?.amountPaise ?? 0;
  const lines = Array.isArray(invoice.lineJson)
    ? (invoice.lineJson as Record<string, unknown>[])
    : [];

  return {
    order,
    invoice: {
      ...invoice,
      amountPaise,
      totalPaise: amountPaise,
      orderCode: order.orderCode,
      supplierLabel: supplier?.publicLabel ?? supplier?.businessName ?? 'Supplier',
      consumerLabel: consumer?.restaurantName ?? 'Buyer',
      deliveryAddress: order.deliveryAddress,
      lines,
      downloadPath: `orders/${order.id}/invoice/download`,
    },
  };
}

ordersRouter.get('/orders/:id/invoice', authenticate, async (req, res) => {
  const bundle = await loadInvoiceBundle(
    requireParam(req, 'id'),
    req.user!.id,
    req.user!.role,
  );
  res.json({ invoice: bundle.invoice });
});

ordersRouter.get('/orders/:id/invoice/download', authenticate, async (req, res) => {
  const bundle = await loadInvoiceBundle(
    requireParam(req, 'id'),
    req.user!.id,
    req.user!.role,
  );
  const { invoice } = bundle;
  const pdf = await buildInvoicePdf({
    invoiceNumber: invoice.invoiceNumber,
    issuedAt: invoice.issuedAt,
    orderCode: invoice.orderCode,
    amountPaise: invoice.amountPaise,
    supplierLabel: invoice.supplierLabel,
    consumerLabel: invoice.consumerLabel,
    deliveryAddress: invoice.deliveryAddress,
    lines: invoice.lines as Array<{
      name?: string;
      quantity?: number;
      qty?: number;
      unit?: string;
      productCategory?: string | null;
      grade?: string;
      rslDaysAtDelivery?: number;
    }>,
  });

  const filename = `${invoice.invoiceNumber}.pdf`.replace(/[^\w.-]+/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(pdf.length));
  res.send(pdf);
});

ordersRouter.post('/orders/:id/payment/start', authenticate, requireRole('consumer'), async (req, res) => {
  const order = await assertOrderAccess(requireParam(req, 'id'), req.user!.id, 'consumer');
  if (order.status !== 'delivered' && order.status !== 'challan_signed') {
    throw new AppError(400, 'NOT_DELIVERED', 'Payment starts only after delivery/challan');
  }

  const existing = await prisma.offlinePayment.findUnique({ where: { orderId: order.id } });
  // Already started (or further) — do not reset timestamps.
  if (
    existing &&
    ['initiated', 'marked_paid_by_consumer', 'confirmed_by_supplier', 'disputed'].includes(
      existing.status,
    )
  ) {
    res.json({ payment: existing, alreadyApplied: true });
    return;
  }

  const payment = await prisma.offlinePayment.upsert({
    where: { orderId: order.id },
    create: {
      orderId: order.id,
      status: 'initiated',
      initiatedAt: new Date(),
      methodNote: req.body?.methodNote,
    },
    update: {
      status: 'initiated',
      initiatedAt: new Date(),
      methodNote: req.body?.methodNote,
    },
  });
  notifyOrderUpdated(
    {
      id: order.id,
      status: order.status,
      consumerUserId: order.consumerUserId,
      supplierUserId: order.supplierUserId,
    },
    {
      paymentStatus: payment.status,
      reason: 'payment_start',
      push: {
        userId: order.supplierUserId,
        title: 'Payment initiated',
        body: 'Consumer started offline payment',
      },
    },
  );
  res.json({ payment });
});

ordersRouter.post(
  '/orders/:id/payment/mark-paid',
  authenticate,
  requireRole('consumer'),
  validateBody(
    z.object({
      reference: z.string().optional(),
      screenshotRef: z.string().optional(),
      methodNote: z.string().optional(),
    }),
  ),
  async (req, res) => {
    const order = await assertOrderAccess(requireParam(req, 'id'), req.user!.id, 'consumer');
    if (!['delivered', 'challan_signed', 'closed'].includes(order.status)) {
      throw new AppError(
        400,
        'NOT_DELIVERED',
        'Mark paid only after delivery (challan signed)',
      );
    }
    const existing = await prisma.offlinePayment.findUnique({ where: { orderId: order.id } });
    if (existing?.status === 'confirmed_by_supplier' || order.status === 'closed') {
      res.json({ payment: existing, alreadyApplied: true });
      return;
    }
    if (existing?.status === 'disputed') {
      throw new AppError(400, 'PAYMENT_DISPUTED', 'Payment is disputed — resolve first');
    }
    if (!existing || existing.status === 'not_started') {
      throw new AppError(
        400,
        'PAYMENT_NOT_STARTED',
        'Start payment first, then mark paid',
      );
    }
    if (existing.status === 'marked_paid_by_consumer') {
      res.json({ payment: existing, alreadyApplied: true });
      return;
    }
    if (existing.status !== 'initiated') {
      throw new AppError(
        400,
        'INVALID_PAYMENT_STATE',
        `Cannot mark paid from status ${existing.status}`,
      );
    }
    const payment = await prisma.offlinePayment.update({
      where: { orderId: order.id },
      data: {
        status: 'marked_paid_by_consumer',
        markedPaidAt: new Date(),
        reference: req.body.reference,
        screenshotRef: req.body.screenshotRef,
        methodNote: req.body.methodNote,
      },
    });
    notifyOrderUpdated(
      {
        id: order.id,
        status: order.status,
        consumerUserId: order.consumerUserId,
        supplierUserId: order.supplierUserId,
      },
      {
        paymentStatus: payment.status,
        reason: 'payment_mark_paid',
        push: {
          userId: order.supplierUserId,
          title: 'Marked paid',
          body: 'Confirm when you receive funds',
        },
      },
    );
    res.json({ payment });
  },
);

ordersRouter.post('/orders/:id/payment/confirm', authenticate, requireRole('supplier'), async (req, res) => {
  const order = await assertOrderAccess(requireParam(req, 'id'), req.user!.id, 'supplier');

  if (order.status === 'closed') {
    const payment = await prisma.offlinePayment.findUnique({ where: { orderId: order.id } });
    res.json({ payment, order, alreadyApplied: true });
    return;
  }

  if (!['delivered', 'challan_signed'].includes(order.status)) {
    throw new AppError(
      400,
      'NOT_READY',
      'Confirm payment only after the consumer signs the challan (order delivered)',
    );
  }

  // COD / offline: supplier can confirm receipt even if consumer skipped "mark paid".
  const payment = await prisma.offlinePayment.upsert({
    where: { orderId: order.id },
    create: {
      orderId: order.id,
      status: 'confirmed_by_supplier',
      confirmedAt: new Date(),
      initiatedAt: new Date(),
      markedPaidAt: new Date(),
    },
    update: {
      status: 'confirmed_by_supplier',
      confirmedAt: new Date(),
    },
  });
  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { status: 'closed' },
  });
  await prisma.orderStatusEvent.create({
    data: {
      orderId: order.id,
      status: 'closed',
      note: 'Supplier confirmed payment received',
    },
  });
  notifyOrderUpdated(
    {
      id: order.id,
      status: updated.status,
      consumerUserId: order.consumerUserId,
      supplierUserId: order.supplierUserId,
    },
    {
      paymentStatus: payment.status,
      reason: 'payment_confirm',
      push: {
        userId: order.consumerUserId,
        title: 'Order closed',
        body: 'Supplier confirmed payment. Order is complete.',
      },
    },
  );
  res.json({ payment, order: updated });
});

ordersRouter.post('/orders/:id/payment/dispute', authenticate, requireRole('supplier'), async (req, res) => {
  const order = await assertOrderAccess(requireParam(req, 'id'), req.user!.id, 'supplier');
  if (!['delivered', 'challan_signed'].includes(order.status)) {
    throw new AppError(400, 'NOT_READY', 'Dispute only after delivery/challan');
  }
  const existing = await prisma.offlinePayment.findUnique({ where: { orderId: order.id } });
  if (existing?.status === 'confirmed_by_supplier') {
    throw new AppError(400, 'ALREADY_CONFIRMED', 'Payment already confirmed');
  }
  if (existing?.status === 'disputed') {
    res.json({ payment: existing, alreadyApplied: true });
    return;
  }
  const payment = await prisma.offlinePayment.upsert({
    where: { orderId: order.id },
    create: {
      orderId: order.id,
      status: 'disputed',
    },
    update: { status: 'disputed' },
  });
  notifyOrderUpdated(
    {
      id: order.id,
      status: order.status,
      consumerUserId: order.consumerUserId,
      supplierUserId: order.supplierUserId,
    },
    {
      paymentStatus: payment.status,
      reason: 'payment_dispute',
      push: {
        userId: order.consumerUserId,
        title: 'Payment disputed',
        body: 'Supplier disputed offline payment. Check the order for next steps.',
      },
    },
  );
  res.json({ payment });
});

const ratingBodySchema = z.object({
  stars: z.coerce.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
});

ordersRouter.get('/orders/:id/ratings', authenticate, async (req, res) => {
  const order = await assertOrderAccess(requireParam(req, 'id'), req.user!.id, req.user!.role);
  const ratings = await prisma.orderRating.findMany({
    where: { orderId: order.id },
    select: {
      id: true,
      fromUserId: true,
      toUserId: true,
      fromRole: true,
      stars: true,
      comment: true,
      createdAt: true,
    },
  });
  const my = ratings.find((r) => r.fromUserId === req.user!.id) ?? null;
  const peer = ratings.find((r) => r.fromUserId !== req.user!.id) ?? null;
  res.json({
    ratings: ratings.map(presentRating),
    myRating: my ? presentRating(my) : null,
    peerRating: peer ? presentRating(peer) : null,
    canRate: order.status === 'closed' && !my,
  });
});

ordersRouter.post(
  '/orders/:id/ratings',
  authenticate,
  validateBody(ratingBodySchema),
  async (req, res) => {
    const order = await assertOrderAccess(requireParam(req, 'id'), req.user!.id, req.user!.role);
    if (order.status !== 'closed') {
      throw new AppError(
        400,
        'NOT_CLOSED',
        'Ratings unlock only after the order is closed (payment confirmed)',
      );
    }

    const isConsumer = order.consumerUserId === req.user!.id;
    const isSupplier = order.supplierUserId === req.user!.id;
    if (!isConsumer && !isSupplier) {
      throw new AppError(403, 'FORBIDDEN', 'Not your order');
    }

    const fromRole = isConsumer ? 'consumer' : 'supplier';
    const toUserId = isConsumer ? order.supplierUserId : order.consumerUserId;
    const stars = req.body.stars as number;
    const comment =
      typeof req.body.comment === 'string' && req.body.comment.trim()
        ? req.body.comment.trim().slice(0, 500)
        : null;

    const existing = await prisma.orderRating.findUnique({
      where: {
        orderId_fromUserId: { orderId: order.id, fromUserId: req.user!.id },
      },
    });
    if (existing) {
      res.json({ rating: presentRating(existing), alreadyApplied: true });
      return;
    }

    const rating = await prisma.$transaction(async (tx) => {
      const created = await tx.orderRating.create({
        data: {
          orderId: order.id,
          fromUserId: req.user!.id,
          toUserId,
          fromRole,
          stars,
          comment,
        },
      });

      if (isConsumer) {
        const profile = await tx.supplierProfile.findUnique({
          where: { userId: toUserId },
        });
        if (profile) {
          const nextCount = profile.ratingCount + 1;
          const nextRating =
            profile.ratingCount === 0 ? stars : ewmaRating(profile.rating, stars);
          await tx.supplierProfile.update({
            where: { id: profile.id },
            data: { rating: nextRating, ratingCount: nextCount },
          });
        }
      } else {
        const profile = await tx.consumerProfile.findUnique({
          where: { userId: toUserId },
        });
        if (profile) {
          const nextCount = profile.ratingCount + 1;
          const nextRating =
            profile.ratingCount === 0 ? stars : ewmaRating(profile.rating, stars);
          const nextTrust = ewmaTrustFromStars(profile.trustScore, stars);
          await tx.consumerProfile.update({
            where: { id: profile.id },
            data: {
              rating: nextRating,
              ratingCount: nextCount,
              trustScore: nextTrust,
            },
          });
        }
      }

      return created;
    });

    notifyOrderUpdated(
      {
        id: order.id,
        status: order.status,
        consumerUserId: order.consumerUserId,
        supplierUserId: order.supplierUserId,
      },
      {
        reason: 'rating_submitted',
        push: {
          userId: toUserId,
          title: 'New rating',
          body: `You received a ${stars}-star rating on order ${order.orderCode}`,
        },
      },
    );

    res.status(201).json({ rating: presentRating(rating) });
  },
);
