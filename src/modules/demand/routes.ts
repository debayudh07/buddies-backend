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
  addressId: z.string().optional(),
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

    // Snapshot the chosen saved address onto the bid request so order creation
    // has a concrete delivery pin even if the profile later changes.
    let deliveryLat = body.lat ?? consumer.lat ?? undefined;
    let deliveryLng = body.lng ?? consumer.lng ?? undefined;
    let deliveryAddress: string | undefined = consumer.addressLine ?? undefined;
    if (body.addressId) {
      const address = await prisma.address.findUnique({ where: { id: body.addressId } });
      if (!address || address.consumerId !== consumer.id) {
        throw new AppError(404, 'NOT_FOUND', 'Address not found');
      }
      deliveryLat = address.lat ?? deliveryLat;
      deliveryLng = address.lng ?? deliveryLng;
      deliveryAddress = [address.line, address.city].filter(Boolean).join(', ') || deliveryAddress;
    }

    // Prefer consumer-selected duration; fall back to configured base window.
    // Clamp so auctions are never shorter than the base window or longer than 7 days.
    const durationSec = Math.min(
      Math.max(
        (body.durationHours ?? 24) * 3600,
        config.auction.baseWindowSec,
      ),
      7 * 24 * 3600,
    );
    const liveEndsAt = new Date(Date.now() + durationSec * 1000);
    const bidRequest = await prisma.bidRequest.create({
      data: {
        batchCode: batchCode(),
        consumerId: consumer.id,
        budgetPaise: body.budgetPaise,
        durationHours: body.durationHours,
        deliveryWindow: body.deliveryWindow,
        deliveryAddress,
        privacyAccepted: true,
        liveEndsAt,
        minDecrementPaise: config.auction.minDecrementPaise,
        lat: deliveryLat,
        lng: deliveryLng,
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

    // Notify verified suppliers off the hot path (response must not wait on fanout).
    void prisma.supplierProfile
      .findMany({
        where: { kycStatus: 'verified' },
        select: { userId: true },
        take: 100,
      })
      .then((suppliers) =>
        notifyMany(
          suppliers.map((s) => s.userId),
          'New Bidzone demand',
          `Batch ${bidRequest.batchCode} is open nearby`,
          { bidRequestId: bidRequest.id },
        ),
      )
      .catch(() => undefined);

    res.status(201).json({ bidRequest });
  },
);

demandRouter.get('/consumer/bid-requests', authenticate, requireRole('consumer'), async (req, res) => {
  const take = Math.min(
    Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1),
    50,
  );
  // One query via nested relation — skip sequential consumerProfile.findUnique.
  const bidRequests = await prisma.bidRequest.findMany({
    where: { consumer: { userId: req.user!.id } },
    select: {
      id: true,
      batchCode: true,
      status: true,
      durationHours: true,
      budgetPaise: true,
      liveEndsAt: true,
      createdAt: true,
      deliveryWindow: true,
      items: {
        select: {
          id: true,
          name: true,
          quantity: true,
          unit: true,
          productCategory: true,
        },
      },
      bids: {
        where: { status: { in: ['active', 'accepted'] } },
        select: {
          id: true,
          amountPaise: true,
          status: true,
          grade: true,
          score: true,
          createdAt: true,
        },
        orderBy: { amountPaise: 'asc' },
        take: 10,
      },
      _count: { select: { bids: true } },
    },
    orderBy: { createdAt: 'desc' },
    take,
  });
  res.json({ bidRequests });
});

demandRouter.get('/consumer/bid-requests/:id', authenticate, async (req, res) => {
  const bidRequest = assertFound(
    await prisma.bidRequest.findUnique({
      where: { id: requireParam(req, 'id') },
      include: {
        consumer: { select: { userId: true } },
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
            order: { select: { id: true, orderCode: true, status: true } },
          },
          orderBy: { score: 'desc' },
        },
      },
    }),
  );

  const isOwner = bidRequest.consumer.userId === req.user!.id;
  const isAdmin = req.user!.role === 'admin';
  if (!isOwner && !isAdmin) {
    // Suppliers browse bidzone feed instead — this path is consumer-owned private data.
    throw new AppError(403, 'FORBIDDEN', 'Not your bid request');
  }

  const { consumer: _c, ...rest } = bidRequest;
  res.json({ bidRequest: rest });
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

    const durationSec = Math.min(
      Math.max(
        (original.durationHours ?? 24) * 3600,
        config.auction.baseWindowSec,
      ),
      7 * 24 * 3600,
    );
    const liveEndsAt = new Date(Date.now() + durationSec * 1000);
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
        deliveryAddress: original.deliveryAddress,
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
