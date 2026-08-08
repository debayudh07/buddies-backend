import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { authenticate, requireRole } from '../../middleware/auth';
import { requireParam } from '../../middleware/params';
import { validateBody } from '../../middleware/validate';
import { AppError, assertFound } from '../../lib/errors';
import { config } from '../../config';
import { emitTracking } from '../../socket';
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
                onTimeRate: true,
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
  const payload = { order: presentOrder(order) };
  responseCacheSet(cacheKey, payload, ORDER_DETAIL_TTL_MS);
  res.setHeader('X-Cache', 'MISS');
  res.json(payload);
});

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

    const allowed: Partial<Record<OrderStatus, OrderStatus[]>> = {
      bid_accepted: ['preparing'],
      preparing: ['out_for_delivery'],
      out_for_delivery: ['arrived'],
      arrived: [],
    };
    const ok = allowed[currentStatus]?.includes(next);
    if (!ok) throw new AppError(400, 'INVALID_TRANSITION', `Cannot go from ${currentStatus} to ${next}`);

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

    const fresh = await prisma.order.findUnique({
      where: { id: order.id },
      include: { trackingSession: true, statusEvents: true, bid: true },
    });
    const effectiveStatus = fresh?.status ?? updated.status;

    emitTracking(order.id, 'order.status_changed', { status: effectiveStatus });
    invalidateOrderCaches(order.id);
    void sendPush({
      userId: order.consumerUserId,
      title: next === 'arrived' ? 'Supplier arrived — sign challan' : 'Order update',
      body:
        next === 'arrived'
          ? 'Inspect goods at the door and sign the digital challan to confirm delivery.'
          : `Status: ${effectiveStatus}`,
      data: { orderId: order.id, status: effectiveStatus },
    }).catch(() => undefined);

    res.json({ order: fresh ?? updated });
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
  if (!['arrived', 'inspection_pending', 'out_for_delivery'].includes(order.status)) {
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
      throw new AppError(400, 'CHALLAN_ALREADY_SIGNED', 'Cannot adjust after sign');
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
    void sendPush({
      userId: order.supplierUserId,
      title: 'Rejected on spot',
      body: req.body.reason,
      data: { orderId: order.id },
    }).catch(() => undefined);
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
    if (['rejected_on_spot', 'delivered', 'challan_signed', 'closed'].includes(order.status)) {
      throw new AppError(400, 'INVALID_STATE', 'Cannot sign in current state');
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

      // GST invoice from challan
      const invNum = `INV-${o.orderCode}`;
      const invoice = await tx.gstInvoice.create({
        data: {
          orderId: o.id,
          invoiceNumber: invNum,
          lineJson: challan.lineSnapshotJson as object,
        },
      });

      return { order: o, challan, invoice };
    });

    await updateSupplierPerformanceOnDelivery(order.supplierUserId, onTime);
    void sendPush({
      userId: order.supplierUserId,
      title: 'Challan signed — delivered',
      body: 'Consumer signed digital challan. Offline payment can start.',
      data: { orderId: order.id },
    }).catch(() => undefined);

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
  const payment = await prisma.offlinePayment.update({
    where: { orderId: order.id },
    data: { status: 'initiated', initiatedAt: new Date(), methodNote: req.body?.methodNote },
  });
  void sendPush({
    userId: order.supplierUserId,
    title: 'Payment initiated',
    body: 'Consumer started offline payment',
    data: { orderId: order.id },
  }).catch(() => undefined);
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
    void sendPush({
      userId: order.supplierUserId,
      title: 'Marked paid',
      body: 'Confirm when you receive funds',
      data: { orderId: order.id },
    }).catch(() => undefined);
    res.json({ payment });
  },
);

ordersRouter.post('/orders/:id/payment/confirm', authenticate, requireRole('supplier'), async (req, res) => {
  const order = await assertOrderAccess(requireParam(req, 'id'), req.user!.id, 'supplier');
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
  emitTracking(order.id, 'order.status_changed', { status: 'closed' });
  void sendPush({
    userId: order.consumerUserId,
    title: 'Order closed',
    body: 'Supplier confirmed payment. Order is complete.',
    data: { orderId: order.id },
  }).catch(() => undefined);
  res.json({ payment, order: updated });
});

ordersRouter.post('/orders/:id/payment/dispute', authenticate, requireRole('supplier'), async (req, res) => {
  const order = await assertOrderAccess(requireParam(req, 'id'), req.user!.id, 'supplier');
  const payment = await prisma.offlinePayment.update({
    where: { orderId: order.id },
    data: { status: 'disputed' },
  });
  res.json({ payment });
});
