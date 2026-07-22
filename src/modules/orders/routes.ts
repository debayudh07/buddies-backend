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

export const ordersRouter = Router();

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

async function getOrderForUser(orderId: string, userId: string, role: string) {
  const order = assertFound(
    await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        bid: true,
        digitalChallan: true,
        offlinePayment: true,
        gstInvoice: true,
        chatThread: true,
        trackingSession: true,
        statusEvents: { orderBy: { createdAt: 'asc' } },
      },
    }),
  );
  if (role !== 'admin' && order.consumerUserId !== userId && order.supplierUserId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Not your order');
  }
  return order;
}

ordersRouter.get('/consumer/orders', authenticate, requireRole('consumer'), async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { consumerUserId: req.user!.id },
    orderBy: { createdAt: 'desc' },
    include: { offlinePayment: true, trackingSession: true },
  });
  res.json({ orders });
});

ordersRouter.get('/supplier/orders', authenticate, requireRole('supplier'), async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { supplierUserId: req.user!.id },
    orderBy: { createdAt: 'desc' },
    include: { offlinePayment: true, trackingSession: true },
  });
  res.json({ orders });
});

ordersRouter.get('/orders/:id', authenticate, async (req, res) => {
  const order = await getOrderForUser(requireParam(req, 'id'), req.user!.id, req.user!.role);
  res.json({ order });
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
    const order = await getOrderForUser(requireParam(req, 'id'), req.user!.id, 'supplier');
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
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: 'inspection_pending',
            inspectionEndsAt: new Date(Date.now() + config.inspectionWindowSec * 1000),
          },
        });
        await tx.orderStatusEvent.create({
          data: { orderId: order.id, status: 'inspection_pending', note: 'Doorstep inspection window started' },
        });
      }
      return o;
    });

    emitTracking(order.id, 'order.status_changed', { status: next });
    await sendPush({
      userId: order.consumerUserId,
      title: 'Order update',
      body: `Status: ${next}`,
      data: { orderId: order.id },
    });

    const fresh = await prisma.order.findUnique({
      where: { id: order.id },
      include: { trackingSession: true, statusEvents: true },
    });
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
    const order = await getOrderForUser(requireParam(req, 'id'), req.user!.id, 'supplier');
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
  const order = await getOrderForUser(requireParam(req, 'id'), req.user!.id, req.user!.role);

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
  const order = await getOrderForUser(requireParam(req, 'id'), req.user!.id, 'consumer');
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
    const order = await getOrderForUser(requireParam(req, 'id'), req.user!.id, 'supplier');
    if (order.digitalChallan && !order.digitalChallan.isDraft) {
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
    const order = await getOrderForUser(requireParam(req, 'id'), req.user!.id, 'consumer');
    if (order.digitalChallan && !order.digitalChallan.isDraft) {
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
    await sendPush({
      userId: order.supplierUserId,
      title: 'Rejected on spot',
      body: req.body.reason,
      data: { orderId: order.id },
    });
    res.json({ order: updated });
  },
);

ordersRouter.post(
  '/orders/:id/inspection/sign-challan',
  authenticate,
  requireRole('consumer'),
  validateBody(z.object({ signatureRef: z.string().optional() })),
  async (req, res) => {
    const order = await getOrderForUser(requireParam(req, 'id'), req.user!.id, 'consumer');
    if (['rejected_on_spot', 'delivered', 'challan_signed', 'closed'].includes(order.status)) {
      throw new AppError(400, 'INVALID_STATE', 'Cannot sign in current state');
    }

    const onTime = !order.slaDeadlineAt || new Date() <= order.slaDeadlineAt;

    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const challan = await tx.digitalChallan.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id,
          isDraft: false,
          signedAt: new Date(),
          signedByUserId: req.user!.id,
          signatureRef: req.body.signatureRef,
          lineSnapshotJson: order.digitalChallan?.lineSnapshotJson ?? [],
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
    await sendPush({
      userId: order.supplierUserId,
      title: 'Challan signed — delivered',
      body: 'Consumer signed digital challan. Offline payment can start.',
      data: { orderId: order.id },
    });

    res.json(result);
  },
);

ordersRouter.get('/orders/:id/challan', authenticate, async (req, res) => {
  const order = await getOrderForUser(requireParam(req, 'id'), req.user!.id, req.user!.role);
  const challan = await prisma.digitalChallan.findUnique({ where: { orderId: order.id } });
  res.json({ challan });
});

ordersRouter.get('/orders/:id/invoice', authenticate, async (req, res) => {
  const order = await getOrderForUser(requireParam(req, 'id'), req.user!.id, req.user!.role);
  const invoice = await prisma.gstInvoice.findUnique({ where: { orderId: order.id } });
  if (!invoice) throw new AppError(404, 'NO_INVOICE', 'Invoice not generated yet — sign challan first');
  res.json({ invoice });
});

ordersRouter.post('/orders/:id/payment/start', authenticate, requireRole('consumer'), async (req, res) => {
  const order = await getOrderForUser(requireParam(req, 'id'), req.user!.id, 'consumer');
  if (order.status !== 'delivered' && order.status !== 'challan_signed') {
    throw new AppError(400, 'NOT_DELIVERED', 'Payment starts only after delivery/challan');
  }
  const payment = await prisma.offlinePayment.update({
    where: { orderId: order.id },
    data: { status: 'initiated', initiatedAt: new Date(), methodNote: req.body?.methodNote },
  });
  await sendPush({
    userId: order.supplierUserId,
    title: 'Payment initiated',
    body: 'Consumer started offline payment',
    data: { orderId: order.id },
  });
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
    const order = await getOrderForUser(requireParam(req, 'id'), req.user!.id, 'consumer');
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
    await sendPush({
      userId: order.supplierUserId,
      title: 'Marked paid',
      body: 'Confirm when you receive funds',
      data: { orderId: order.id },
    });
    res.json({ payment });
  },
);

ordersRouter.post('/orders/:id/payment/confirm', authenticate, requireRole('supplier'), async (req, res) => {
  const order = await getOrderForUser(requireParam(req, 'id'), req.user!.id, 'supplier');
  const payment = await prisma.offlinePayment.update({
    where: { orderId: order.id },
    data: { status: 'confirmed_by_supplier', confirmedAt: new Date() },
  });
  await prisma.order.update({ where: { id: order.id }, data: { status: 'closed' } });
  res.json({ payment });
});

ordersRouter.post('/orders/:id/payment/dispute', authenticate, requireRole('supplier'), async (req, res) => {
  const order = await getOrderForUser(requireParam(req, 'id'), req.user!.id, 'supplier');
  const payment = await prisma.offlinePayment.update({
    where: { orderId: order.id },
    data: { status: 'disputed' },
  });
  res.json({ payment });
});
