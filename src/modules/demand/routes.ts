import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate, requireRole } from '../../middleware/auth';
import { requireParam } from '../../middleware/params';
import { validateBody } from '../../middleware/validate';
import { AppError, assertFound } from '../../lib/errors';
import { config } from '../../config';
import { emitAuction, emitBidzone, emitUser } from '../../socket';
import { publicSupplierLabel } from '../../lib/user-present';
import { notifyMany } from '../../lib/notify';
import {
  categorySlugs,
  normalizeProductCategory,
} from '../../lib/product-categories';
import {
  assertCartRule,
  canonicalizeLine,
  type CanonicalLine,
  type IncomingCatalogLine,
} from '../../lib/product-catalog';
import { invalidateBidzoneFeeds, invalidateConsumerLists, cacheGet, cacheSet } from '../../lib/response-cache';

const knownCategory = z
  .string()
  .min(1)
  .transform((s, ctx) => {
    const n = normalizeProductCategory(s);
    if (!n || !categorySlugs().includes(n)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown product category. Choose one of: ${categorySlugs().join(', ')}`,
      });
      return z.NEVER;
    }
    return n;
  });

const catalogItemSchema = z.object({
  catalogCategory: z.string().min(1).optional(),
  catalogItemSlug: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  quantity: z.number().positive(),
  unit: z.string().min(1).optional(),
  productCategory: knownCategory.optional(),
  gradeHint: z.string().optional(),
});

function canonicalizeItems(raw: IncomingCatalogLine[]): CanonicalLine[] {
  const out: CanonicalLine[] = [];
  for (const line of raw) {
    if (!line.catalogCategory || !line.catalogItemSlug) {
      // Legacy APK path: free-text name + shelf productCategory.
      if (!line.name || !line.productCategory || !line.unit) {
        throw new AppError(
          400,
          'UNKNOWN_ITEM',
          'Each line needs catalogCategory and catalogItemSlug (or legacy name, unit, productCategory)',
        );
      }
      out.push({
        catalogCategory: '',
        catalogItemSlug: '',
        name: line.name,
        quantity: line.quantity,
        unit: (line.unit as CanonicalLine['unit']) ?? 'kg',
        productCategory: line.productCategory,
        minimumOrderQty: 0,
        minimumOrderUnit: (line.unit as CanonicalLine['unit']) ?? 'kg',
        gradeHint: line.gradeHint,
      });
      continue;
    }
    const canonical = canonicalizeLine(line);
    if ('code' in canonical) {
      throw new AppError(400, canonical.code, canonical.message);
    }
    out.push(canonical);
  }
  const cartErr = assertCartRule(out);
  if (cartErr) throw new AppError(400, cartErr.code, cartErr.message);
  return out;
}

function itemCreateData(i: CanonicalLine) {
  return {
    name: i.name,
    quantity: i.quantity,
    unit: i.unit,
    productCategory: i.productCategory,
    gradeHint: i.gradeHint,
    catalogCategory: i.catalogCategory || null,
    catalogItemSlug: i.catalogItemSlug || null,
    minimumOrderQty: i.minimumOrderQty || null,
    minimumOrderUnit: i.minimumOrderUnit || null,
  };
}

const createSchema = z.object({
  budgetPaise: z.number().int().positive().optional(),
  /** Auction length in hours. Use `0` for Instant (30 minutes). */
  durationHours: z.number().int().min(0).max(7 * 24).default(24),
  deliveryWindow: z.string().optional(),
  privacyAccepted: z.boolean(),
  addressId: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  items: z.array(catalogItemSchema).min(1),
});

/** Resolve auction window seconds from stored durationHours (0 = Instant 30 min). */
function auctionWindowSec(durationHours: number | null | undefined): number {
  const h = durationHours ?? 24;
  // Instant is a fixed short window — never raise it to AUCTION_BASE_WINDOW_SEC
  // (often 24h in env), which would force "Instant" to last a full day.
  if (h === 0) {
    return 30 * 60;
  }
  const desiredSec = h * 3600;
  return Math.min(
    Math.max(desiredSec, config.auction.baseWindowSec),
    7 * 24 * 3600,
  );
}

const itemSchema = catalogItemSchema;

const patchSchema = z
  .object({
    deliveryWindow: z.string().min(1).optional(),
    addressId: z.string().uuid().optional(),
    items: z.array(itemSchema).min(1).optional(),
  })
  .refine((b) => b.deliveryWindow != null || b.addressId != null || b.items != null, {
    message: 'Provide deliveryWindow, addressId, and/or items',
  });

function itemsEditPolicy(createdAt: Date, now = new Date()) {
  const windowSec = config.auction.itemsEditWindowSec;
  const endsAt = new Date(createdAt.getTime() + windowSec * 1000);
  const remainingMs = endsAt.getTime() - now.getTime();
  const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
  return {
    itemsEditWindowSec: windowSec,
    itemsEditEndsAt: endsAt,
    itemsEditSecRemaining: remainingSec,
    canEditItems: remainingSec > 0,
  };
}

function canEditMeta(status: string, liveEndsAt: Date, now = new Date()) {
  return status === 'open' && liveEndsAt.getTime() > now.getTime();
}

export const demandRouter = Router();

function batchCode() {
  const n = Math.floor(Math.random() * 9000) + 1000;
  return `RI-${n}`;
}

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

    const canonicalItems = canonicalizeItems(body.items as IncomingCatalogLine[]);

    // Prefer consumer-selected duration; Instant (durationHours=0) = 30 minutes.
    const durationSec = auctionWindowSec(body.durationHours);
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
          create: canonicalItems.map(itemCreateData),
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

    await Promise.all([
      invalidateBidzoneFeeds(),
      invalidateConsumerLists(req.user!.id),
    ]);
    res.status(201).json({ bidRequest });
  },
);

demandRouter.get('/consumer/bid-requests', authenticate, requireRole('consumer'), async (req, res) => {
  const take = Math.min(
    Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1),
    50,
  );
  const cacheKey = `demand:list:${req.user!.id}:${take}`;
  const cached = await cacheGet<{ bidRequests: unknown }>(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    res.json(cached);
    return;
  }
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
          catalogCategory: true,
          catalogItemSlug: true,
          minimumOrderQty: true,
          minimumOrderUnit: true,
          status: true,
        },
      },
      bids: {
        where: {
          OR: [
            { status: 'accepted' },
            {
              status: 'active',
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
          ],
        },
        select: {
          id: true,
          amountPaise: true,
          status: true,
          grade: true,
          score: true,
          createdAt: true,
          expiresAt: true,
        },
        orderBy: { amountPaise: 'asc' },
        take: 10,
      },
      _count: {
        select: {
          bids: {
            where: {
              OR: [
                { status: 'accepted' },
                {
                  status: 'active',
                  OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
                },
              ],
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take,
  });
  const payload = { bidRequests };
  await cacheSet(cacheKey, payload, 8_000);
  res.setHeader('X-Cache', 'MISS');
  res.json(payload);
});

demandRouter.get('/consumer/bid-requests/:id', authenticate, async (req, res) => {
  const bidRequest = assertFound(
    await prisma.bidRequest.findUnique({
      where: { id: requireParam(req, 'id') },
      include: {
        consumer: { select: { userId: true } },
        items: true,
        bids: {
          where: {
            OR: [
              { status: 'accepted' },
              {
                status: 'active',
                OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
              },
            ],
          },
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
            bidLines: true,
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
  const now = new Date();
  
  // Find all accepted bids for this bidRequest
  const acceptedBids = await prisma.bid.findMany({
    where: {
      bidRequestId: bidRequest.id,
      status: 'accepted',
    },
    select: { id: true, coveredItemIds: true, bidLines: { select: { bidRequestItemId: true } } },
  });

  const itemsStatus = bidRequest.items.map((i) => {
    const winners = acceptedBids.filter((b) => {
      if (i.awardedBidId) return b.id === i.awardedBidId;
      if (b.bidLines.length > 0) return b.bidLines.some((l) => l.bidRequestItemId === i.id);
      return b.coveredItemIds.length === 0 || b.coveredItemIds.includes(i.id);
    });
    return {
      id: i.id,
      name: i.name,
      quantity: i.quantity,
      unit: i.unit,
      status: i.status,
      winnerCount: winners.length,
    };
  });

  const itemsPolicy = itemsEditPolicy(bidRequest.createdAt, now);
  res.json({
    bidRequest: {
      ...rest,
      bids: (rest.bids ?? []).map((b) =>
        b.supplier
          ? {
              ...b,
              supplier: {
                ...b.supplier,
                publicLabel: publicSupplierLabel(b.supplier),
              },
            }
          : b,
      ),
      itemsStatus,
      editPolicy: {
        canEditMeta: canEditMeta(bidRequest.status, bidRequest.liveEndsAt, now),
        ...itemsPolicy,
        canEditItems:
          canEditMeta(bidRequest.status, bidRequest.liveEndsAt, now) &&
          itemsPolicy.canEditItems,
      },
    },
  });
});

/** Patch open RFQ: address / delivery window anytime while open; items only for 30s. */
demandRouter.patch(
  '/consumer/bid-requests/:id',
  authenticate,
  requireRole('consumer'),
  validateBody(patchSchema),
  async (req, res) => {
    const id = requireParam(req, 'id');
    const body = req.body as z.infer<typeof patchSchema>;
    const bidRequest = assertFound(
      await prisma.bidRequest.findUnique({
        where: { id },
        include: { consumer: true, items: true },
      }),
    );
    if (bidRequest.consumer.userId !== req.user!.id) {
      throw new AppError(403, 'FORBIDDEN', 'Not your bid request');
    }
    const now = new Date();
    if (!canEditMeta(bidRequest.status, bidRequest.liveEndsAt, now)) {
      throw new AppError(
        400,
        'NOT_EDITABLE',
        'Only open bid requests with time remaining can be edited',
      );
    }

    if (body.items) {
      const policy = itemsEditPolicy(bidRequest.createdAt, now);
      if (!policy.canEditItems) {
        throw new AppError(
          400,
          'ITEMS_EDIT_LOCKED',
          `Items can only be edited within ${policy.itemsEditWindowSec} seconds of creating the request`,
        );
      }
    }

    const canonicalItems = body.items
      ? canonicalizeItems(body.items as IncomingCatalogLine[])
      : null;

    let deliveryLat = bidRequest.lat ?? undefined;
    let deliveryLng = bidRequest.lng ?? undefined;
    let deliveryAddress = bidRequest.deliveryAddress ?? undefined;

    if (body.addressId) {
      const address = await prisma.address.findUnique({ where: { id: body.addressId } });
      if (!address || address.consumerId !== bidRequest.consumerId) {
        throw new AppError(404, 'NOT_FOUND', 'Address not found');
      }
      deliveryLat = address.lat ?? deliveryLat;
      deliveryLng = address.lng ?? deliveryLng;
      deliveryAddress =
        [address.line, address.city].filter(Boolean).join(', ') || deliveryAddress;
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (canonicalItems) {
        await tx.bidRequestItem.deleteMany({ where: { bidRequestId: id } });
        await tx.bidRequestItem.createMany({
          data: canonicalItems.map((i) => ({
            bidRequestId: id,
            ...itemCreateData(i),
          })),
        });
      }

      return tx.bidRequest.update({
        where: { id },
        data: {
          ...(body.deliveryWindow != null ? { deliveryWindow: body.deliveryWindow } : {}),
          ...(body.addressId
            ? {
                deliveryAddress,
                lat: deliveryLat,
                lng: deliveryLng,
              }
            : {}),
        },
        include: { items: true },
      });
    });

    emitAuction(id, 'auction.updated', {
      bidRequestId: id,
      deliveryWindow: updated.deliveryWindow,
      itemCount: updated.items.length,
    });
    emitBidzone('all', 'demand.request_updated', {
      id,
      batchCode: updated.batchCode,
      itemCount: updated.items.length,
      liveEndsAt: updated.liveEndsAt,
    });
    emitUser(bidRequest.consumer.userId, 'bidRequest.updated', {
      id,
      status: updated.status,
    });

    const itemsPolicy = itemsEditPolicy(updated.createdAt, new Date());
    await Promise.all([
      invalidateBidzoneFeeds(),
      invalidateConsumerLists(req.user!.id),
    ]);
    res.json({
      bidRequest: {
        ...updated,
        editPolicy: {
          canEditMeta: canEditMeta(updated.status, updated.liveEndsAt),
          ...itemsPolicy,
          canEditItems:
            canEditMeta(updated.status, updated.liveEndsAt) && itemsPolicy.canEditItems,
        },
      },
      message: 'Bid request updated',
    });
  },
);

/** Cancel an open bid request before the auction timer ends (consumer only). */
demandRouter.post(
  '/consumer/bid-requests/:id/cancel',
  authenticate,
  requireRole('consumer'),
  async (req, res) => {
    const id = requireParam(req, 'id');
    const bidRequest = assertFound(
      await prisma.bidRequest.findUnique({
        where: { id },
        include: { consumer: { select: { userId: true } } },
      }),
    );
    if (bidRequest.consumer.userId !== req.user!.id) {
      throw new AppError(403, 'FORBIDDEN', 'Not your bid request');
    }
    if (bidRequest.status !== 'open') {
      throw new AppError(
        400,
        'NOT_OPEN',
        bidRequest.status === 'cancelled'
          ? 'This request is already cancelled'
          : 'Only open bid requests can be cancelled',
      );
    }
    if (bidRequest.liveEndsAt.getTime() <= Date.now()) {
      throw new AppError(
        400,
        'EXPIRED',
        'Auction timer has already finished — cannot cancel',
      );
    }

    const updated = await prisma.$transaction(async (tx) => {
      const live = await tx.bidRequest.updateMany({
        where: { id, status: 'open' },
        data: { status: 'cancelled' },
      });
      if (live.count === 0) {
        throw new AppError(400, 'NOT_OPEN', 'Request is no longer open');
      }
      await tx.bid.updateMany({
        where: { bidRequestId: id, status: 'active' },
        data: { status: 'expired' },
      });
      return tx.bidRequest.findUnique({
        where: { id },
        include: { items: true },
      });
    });

    emitAuction(id, 'auction.cancelled', {
      bidRequestId: id,
      status: 'cancelled',
    });
    emitBidzone('all', 'demand.request_cancelled', {
      id,
      batchCode: bidRequest.batchCode,
    });
    emitUser(bidRequest.consumer.userId, 'bidRequest.updated', {
      id,
      status: 'cancelled',
    });

    await Promise.all([
      invalidateBidzoneFeeds(),
      invalidateConsumerLists(req.user!.id),
    ]);
    res.json({ bidRequest: updated, message: 'Bid request cancelled' });
  },
);

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

    const durationSec = auctionWindowSec(original.durationHours);
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
            catalogCategory: i.catalogCategory,
            catalogItemSlug: i.catalogItemSlug,
            minimumOrderQty: i.minimumOrderQty,
            minimumOrderUnit: i.minimumOrderUnit,
          })),
        },
      },
      include: { items: true },
    });

    emitAuction(bidRequest.id, 'demand.reordered', { id: bidRequest.id });
    await Promise.all([
      invalidateBidzoneFeeds(),
      invalidateConsumerLists(req.user!.id),
    ]);
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
