import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate, requireRole } from '../../middleware/auth';
import { requireParam } from '../../middleware/params';
import { validateBody } from '../../middleware/validate';
import { AppError, assertFound } from '../../lib/errors';
import { config } from '../../config';
import { emitAuction, emitBidzone } from '../../socket';
import { notifyMany } from '../../lib/notify';

export const demandRouter = Router();

function batchCode() {
  const n = Math.floor(Math.random() * 9000) + 1000;
  return `RI-${n}`;
}

const createSchema = z.object({
  budgetPaise: z.number().int().positive().optional(),
  durationHours: z.number().int().positive().default(24),
  deliveryWindow: z.string().optional(),
  privacyAccepted: z.boolean(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        quantity: z.number().positive(),
        unit: z.string().min(1),
        productCategory: z.string().optional(),
        gradeHint: z.string().optional(),
      }),
    )
    .min(1),
});

demandRouter.post(
  '/consumer/bid-requests',
  authenticate,
  requireRole('consumer'),
  validateBody(createSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    if (!body.privacyAccepted) {
      throw new AppError(400, 'PRIVACY_REQUIRED', 'Privacy policy must be accepted');
    }

    let consumer = await prisma.consumerProfile.findUnique({ where: { userId: req.user!.id } });
    if (!consumer) {
      consumer = await prisma.consumerProfile.create({
        data: { userId: req.user!.id, restaurantName: 'Restaurant' },
      });
    }

    await prisma.user.update({
      where: { id: req.user!.id },
      data: { privacyAcceptedAt: new Date() },
    });

    const liveEndsAt = new Date(Date.now() + config.auction.baseWindowSec * 1000);
    const bidRequest = await prisma.bidRequest.create({
      data: {
        batchCode: batchCode(),
        consumerId: consumer.id,
        budgetPaise: body.budgetPaise,
        durationHours: body.durationHours,
        deliveryWindow: body.deliveryWindow,
        privacyAccepted: true,
        liveEndsAt,
        minDecrementPaise: config.auction.minDecrementPaise,
        lat: body.lat ?? consumer.lat ?? undefined,
        lng: body.lng ?? consumer.lng ?? undefined,
        items: {
          create: body.items.map((i) => ({
            name: i.name,
            quantity: i.quantity,
            unit: i.unit,
            productCategory: i.productCategory,
            gradeHint: i.gradeHint,
          })),
        },
      },
      include: { items: true },
    });

    emitBidzone('all', 'demand.request_created', {
      id: bidRequest.id,
      batchCode: bidRequest.batchCode,
      liveEndsAt: bidRequest.liveEndsAt,
      itemCount: bidRequest.items.length,
    });

    // Notify verified suppliers (stub fanout)
    const suppliers = await prisma.supplierProfile.findMany({
      where: { kycStatus: 'verified' },
      select: { userId: true },
      take: 100,
    });
    await notifyMany(
      suppliers.map((s: (typeof suppliers)[number]) => s.userId),
      'New Bidzone demand',
      `Batch ${bidRequest.batchCode} is open nearby`,
      { bidRequestId: bidRequest.id },
    );

    res.status(201).json({ bidRequest });
  },
);

demandRouter.get('/consumer/bid-requests', authenticate, requireRole('consumer'), async (req, res) => {
  const consumer = await prisma.consumerProfile.findUnique({ where: { userId: req.user!.id } });
  if (!consumer) return res.json({ bidRequests: [] });
  const bidRequests = await prisma.bidRequest.findMany({
    where: { consumerId: consumer.id },
    include: { items: true, bids: { where: { status: { in: ['active', 'accepted'] } } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ bidRequests });
});

demandRouter.get('/consumer/bid-requests/:id', authenticate, async (req, res) => {
  const bidRequest = assertFound(
    await prisma.bidRequest.findUnique({
      where: { id: requireParam(req, 'id') },
      include: {
        items: true,
        bids: {
          where: { status: { in: ['active', 'accepted'] } },
          include: {
            supplier: {
              select: {
                id: true,
                publicLabel: true,
                rating: true,
                onTimeRate: true,
                returnRate: true,
                lat: true,
                lng: true,
                kycStatus: true,
              },
            },
          },
          orderBy: { score: 'desc' },
        },
      },
    }),
  );

  // Mask: never expose consumer private address on this payload for suppliers
  const publicView = {
    ...bidRequest,
    consumerId: undefined,
    consumerMasked: true,
  };

  res.json({ bidRequest: publicView });
});

demandRouter.post(
  '/consumer/bid-requests/:id/reorder',
  authenticate,
  requireRole('consumer'),
  async (req, res) => {
    const original = assertFound(
      await prisma.bidRequest.findUnique({
        where: { id: requireParam(req, 'id') },
        include: { items: true, consumer: true },
      }),
    );
    if (original.consumer.userId !== req.user!.id) {
      throw new AppError(403, 'FORBIDDEN', 'Not your bid request');
    }

    const liveEndsAt = new Date(Date.now() + config.auction.baseWindowSec * 1000);
    const bidRequest = await prisma.bidRequest.create({
      data: {
        batchCode: batchCode(),
        consumerId: original.consumerId,
        budgetPaise: original.budgetPaise,
        durationHours: original.durationHours,
        deliveryWindow: original.deliveryWindow,
        privacyAccepted: true,
        liveEndsAt,
        minDecrementPaise: original.minDecrementPaise,
        lat: original.lat,
        lng: original.lng,
        reorderOfId: original.id,
        items: {
          create: original.items.map((i: (typeof original.items)[number]) => ({
            name: i.name,
            quantity: i.quantity,
            unit: i.unit,
            productCategory: i.productCategory,
            gradeHint: i.gradeHint,
          })),
        },
      },
      include: { items: true },
    });

    emitAuction(bidRequest.id, 'demand.reordered', { id: bidRequest.id });
    res.status(201).json({ bidRequest });
  },
);

demandRouter.post(
  '/consumer/standing-rfqs',
  authenticate,
  requireRole('consumer'),
  validateBody(z.object({ bidRequestId: z.string().uuid(), cronHint: z.string().optional() })),
  async (req, res) => {
    const br = assertFound(await prisma.bidRequest.findUnique({
      where: { id: req.body.bidRequestId },
      include: { consumer: true },
    }));
    if (br.consumer.userId !== req.user!.id) throw new AppError(403, 'FORBIDDEN', 'Not yours');
    const standing = await prisma.standingRfq.create({
      data: {
        consumerId: br.consumerId,
        bidRequestId: br.id,
        cronHint: req.body.cronHint,
      },
    });
    res.status(201).json({ standing });
  },
);
