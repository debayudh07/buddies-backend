import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { authenticate, requireRole } from '../../middleware/auth';
import { requireParam } from '../../middleware/params';
import { AppError, assertFound } from '../../lib/errors';
import { parseLimit } from '../../lib/pagination';
import { publicSupplierLabel } from '../../lib/user-present';
import { PRODUCT_CATEGORIES } from '../../lib/product-categories';
import { emitAuction, emitBidzone, emitUser } from '../../socket';
import {
  invalidateBidzoneFeeds,
  invalidateConsumerLists,
  invalidateDemandDetail,
} from '../../lib/response-cache';
import { recordAdminAudit } from './audit';

export const adminRouter = Router();

const adminOnly = [authenticate, requireRole('admin')] as const;

function rangeFromQuery(raw: unknown): Date {
  const key = typeof raw === 'string' ? raw : '7d';
  const days = key === 'today' ? 1 : key === '30d' ? 30 : 7;
  const start = new Date();
  if (key === 'today') {
    start.setHours(0, 0, 0, 0);
    return start;
  }
  start.setDate(start.getDate() - days);
  return start;
}

adminRouter.get('/admin/me', ...adminOnly, async (req, res) => {
  const user = assertFound(
    await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        role: true,
        phone: true,
        email: true,
        displayName: true,
        createdAt: true,
      },
    }),
  );
  res.json({ user });
});

adminRouter.get('/admin/metrics', ...adminOnly, async (req, res) => {
  const since = rangeFromQuery(req.query.range);
  const now = new Date();

  const [
    consumers,
    suppliers,
    pendingKyc,
    openAuctions,
    liveBids,
    awardedAuctions,
    expiredAuctions,
    ordersByStatus,
    gmv,
    slaBreached,
    openReturns,
    openTickets,
    newConsumers,
    newSuppliers,
    newOrders,
  ] = await Promise.all([
    prisma.user.count({ where: { role: 'consumer' } }),
    prisma.user.count({ where: { role: 'supplier' } }),
    prisma.supplierProfile.count({ where: { kycStatus: 'submitted' } }),
    prisma.bidRequest.count({ where: { status: 'open', liveEndsAt: { gt: now } } }),
    prisma.bid.count({
      where: {
        status: 'active',
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    }),
    prisma.bidRequest.count({ where: { status: 'awarded', createdAt: { gte: since } } }),
    prisma.bidRequest.count({ where: { status: 'expired', createdAt: { gte: since } } }),
    prisma.order.groupBy({
      by: ['status'],
      _count: { id: true },
    }),
    prisma.order.findMany({
      where: {
        status: { notIn: ['rejected_on_spot'] },
        createdAt: { gte: since },
      },
      select: { bid: { select: { amountPaise: true } } },
    }),
    prisma.order.count({ where: { slaStatus: 'breached' } }),
    prisma.returnClaim.count({
      where: {
        status: {
          in: ['submitted', 'supplier_review', 'auto_approved', 'pickup_scheduled'],
        },
      },
    }),
    prisma.supportTicket.count({
      where: { status: { in: ['open', 'pending_user', 'pending_ops'] } },
    }),
    prisma.user.count({ where: { role: 'consumer', createdAt: { gte: since } } }),
    prisma.user.count({ where: { role: 'supplier', createdAt: { gte: since } } }),
    prisma.order.count({ where: { createdAt: { gte: since } } }),
  ]);

  const gmvPaise = gmv.reduce((sum, o) => sum + (o.bid?.amountPaise ?? 0), 0);
  const orders = Object.fromEntries(ordersByStatus.map((r) => [r.status, r._count.id]));

  res.json({
    range: typeof req.query.range === 'string' ? req.query.range : '7d',
    since,
    restaurants: { total: consumers, newInRange: newConsumers },
    shops: { total: suppliers, pendingKyc, newInRange: newSuppliers },
    auctions: {
      open: openAuctions,
      liveBids,
      awardedInRange: awardedAuctions,
      expiredInRange: expiredAuctions,
    },
    orders: {
      byStatus: orders,
      newInRange: newOrders,
      gmvPaise,
      slaBreached,
    },
    returns: { open: openReturns },
    support: { openTickets },
  });
});

adminRouter.get('/admin/kyc/suppliers', ...adminOnly, async (req, res) => {
  const kycStatus =
    typeof req.query.kycStatus === 'string' ? req.query.kycStatus : undefined;
  const take = parseLimit(req.query.limit, { defaultLimit: 80, max: 200 });
  const profiles = await prisma.supplierProfile.findMany({
    where: kycStatus ? { kycStatus: kycStatus as never } : undefined,
    include: {
      user: { select: { id: true, displayName: true, phone: true, email: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take,
  });
  res.json({
    suppliers: profiles.map((p) => ({
      ...p,
      shopLabel: publicSupplierLabel(p),
    })),
  });
});

adminRouter.get('/admin/kyc/suppliers/:userId', ...adminOnly, async (req, res) => {
  const userId = requireParam(req, 'userId');
  const profile = assertFound(
    await prisma.supplierProfile.findUnique({
      where: { userId },
      include: {
        user: { select: { id: true, displayName: true, phone: true, email: true, createdAt: true } },
      },
    }),
  );
  res.json({
    supplier: {
      ...profile,
      shopLabel: publicSupplierLabel(profile),
    },
  });
});

async function setSupplierKyc(
  userId: string,
  kycStatus: 'verified' | 'rejected',
  actorId: string,
) {
  const profile = await prisma.supplierProfile.update({
    where: { userId },
    data: { kycStatus },
  });
  await recordAdminAudit({
    actorId,
    action: kycStatus === 'verified' ? 'kyc.verify' : 'kyc.reject',
    target: `supplier:${userId}`,
    meta: { kycStatus },
  });
  return profile;
}

adminRouter.post(
  '/admin/kyc/suppliers/:userId/verify',
  ...adminOnly,
  async (req, res) => {
    const profile = await setSupplierKyc(
      requireParam(req, 'userId'),
      'verified',
      req.user!.id,
    );
    res.json({ profile });
  },
);

adminRouter.post(
  '/admin/kyc/suppliers/:userId/reject',
  ...adminOnly,
  async (req, res) => {
    const profile = await setSupplierKyc(
      requireParam(req, 'userId'),
      'rejected',
      req.user!.id,
    );
    res.json({ profile });
  },
);

adminRouter.get('/admin/restaurants', ...adminOnly, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const take = parseLimit(req.query.limit, { defaultLimit: 60, max: 200 });
  const restaurants = await prisma.consumerProfile.findMany({
    where: q
      ? {
          OR: [
            { restaurantName: { contains: q, mode: 'insensitive' } },
            { city: { contains: q, mode: 'insensitive' } },
            { user: { phone: { contains: q } } },
          ],
        }
      : undefined,
    include: {
      user: { select: { id: true, phone: true, displayName: true, createdAt: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take,
  });
  res.json({ restaurants });
});

adminRouter.get('/admin/users', ...adminOnly, async (req, res) => {
  const role = typeof req.query.role === 'string' ? req.query.role : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const take = parseLimit(req.query.limit, { defaultLimit: 60, max: 200 });
  const users = await prisma.user.findMany({
    where: {
      ...(role === 'consumer' || role === 'supplier' || role === 'admin'
        ? { role }
        : {}),
      ...(q
        ? {
            OR: [
              { phone: { contains: q } },
              { email: { contains: q, mode: 'insensitive' } },
              { displayName: { contains: q, mode: 'insensitive' } },
              { consumerProfile: { restaurantName: { contains: q, mode: 'insensitive' } } },
              { supplierProfile: { publicLabel: { contains: q, mode: 'insensitive' } } },
              { supplierProfile: { businessName: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
    include: {
      consumerProfile: { select: { restaurantName: true, city: true } },
      supplierProfile: {
        select: { publicLabel: true, businessName: true, kycStatus: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take,
  });
  res.json({
    users: users.map((u) => ({
      id: u.id,
      role: u.role,
      phone: u.phone,
      email: u.email,
      displayName: u.displayName,
      createdAt: u.createdAt,
      restaurantName: u.consumerProfile?.restaurantName ?? null,
      city: u.consumerProfile?.city ?? null,
      shopLabel: u.supplierProfile
        ? publicSupplierLabel(u.supplierProfile)
        : null,
      kycStatus: u.supplierProfile?.kycStatus ?? null,
    })),
  });
});

adminRouter.get('/admin/users/:id', ...adminOnly, async (req, res) => {
  const id = requireParam(req, 'id');
  const user = assertFound(
    await prisma.user.findUnique({
      where: { id },
      include: {
        consumerProfile: true,
        supplierProfile: true,
        subscriptions: { orderBy: { createdAt: 'desc' }, take: 3 },
      },
    }),
  );
  const [orders, bids, bidRequests] = await Promise.all([
    prisma.order.findMany({
      where: { OR: [{ consumerUserId: id }, { supplierUserId: id }] },
      orderBy: { createdAt: 'desc' },
      take: 12,
      select: {
        id: true,
        orderCode: true,
        status: true,
        slaStatus: true,
        slaDeadlineAt: true,
        createdAt: true,
        bid: { select: { amountPaise: true } },
      },
    }),
    prisma.bid.findMany({
      where: { supplier: { userId: id } },
      orderBy: { createdAt: 'desc' },
      take: 12,
      select: {
        id: true,
        amountPaise: true,
        status: true,
        createdAt: true,
        bidRequest: { select: { batchCode: true, id: true } },
      },
    }),
    prisma.bidRequest.findMany({
      where: { consumer: { userId: id } },
      orderBy: { createdAt: 'desc' },
      take: 12,
      select: {
        id: true,
        batchCode: true,
        status: true,
        createdAt: true,
        deliveryWindow: true,
      },
    }),
  ]);
  res.json({
    user: {
      ...user,
      shopLabel: user.supplierProfile
        ? publicSupplierLabel(user.supplierProfile)
        : null,
    },
    orders,
    bids,
    bidRequests,
  });
});

adminRouter.get('/admin/bid-requests', ...adminOnly, async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const take = parseLimit(req.query.limit, { defaultLimit: 50, max: 150 });
  const rows = await prisma.bidRequest.findMany({
    where: status ? { status: status as never } : undefined,
    orderBy: { createdAt: 'desc' },
    take,
    include: {
      consumer: { select: { restaurantName: true, userId: true } },
      items: { select: { id: true, name: true, quantity: true, unit: true } },
      _count: { select: { bids: true, orders: true } },
    },
  });
  res.json({
    bidRequests: rows.map((r) => ({
      id: r.id,
      batchCode: r.batchCode,
      status: r.status,
      durationHours: r.durationHours,
      deliveryWindow: r.deliveryWindow,
      preferredDeliverBy: r.preferredDeliverBy,
      liveEndsAt: r.liveEndsAt,
      createdAt: r.createdAt,
      restaurantName: r.consumer.restaurantName,
      consumerUserId: r.consumer.userId,
      itemCount: r.items.length,
      bidCount: r._count.bids,
      orderCount: r._count.orders,
    })),
  });
});

adminRouter.get('/admin/bid-requests/:id', ...adminOnly, async (req, res) => {
  const id = requireParam(req, 'id');
  const br = assertFound(
    await prisma.bidRequest.findUnique({
      where: { id },
      include: {
        consumer: {
          select: { restaurantName: true, userId: true, city: true },
        },
        items: true,
        bids: {
          include: {
            supplier: {
              select: { publicLabel: true, businessName: true, userId: true },
            },
            bidLines: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        orders: {
          select: { id: true, orderCode: true, status: true, supplierUserId: true },
        },
      },
    }),
  );
  res.json({
    bidRequest: {
      ...br,
      bids: br.bids.map((b) => ({
        ...b,
        shopLabel: publicSupplierLabel(b.supplier),
      })),
    },
  });
});

adminRouter.post('/admin/bid-requests/:id/cancel', ...adminOnly, async (req, res) => {
  const id = requireParam(req, 'id');
  const bidRequest = assertFound(
    await prisma.bidRequest.findUnique({
      where: { id },
      include: { consumer: { select: { userId: true } } },
    }),
  );
  if (bidRequest.status !== 'open') {
    throw new AppError(400, 'NOT_OPEN', 'Only open requests can be cancelled');
  }
  if (bidRequest.liveEndsAt.getTime() <= Date.now()) {
    throw new AppError(400, 'EXPIRED', 'Auction timer has already finished');
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
    return tx.bidRequest.findUnique({ where: { id }, include: { items: true } });
  });
  await recordAdminAudit({
    actorId: req.user!.id,
    action: 'auction.cancel',
    target: `bidRequest:${id}`,
    meta: { batchCode: bidRequest.batchCode },
  });
  emitAuction(id, 'auction.cancelled', { bidRequestId: id, status: 'cancelled' });
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
    invalidateConsumerLists(bidRequest.consumer.userId),
    invalidateDemandDetail(id),
  ]);
  res.json({ bidRequest: updated, message: 'Request cancelled' });
});

adminRouter.get('/admin/orders', ...adminOnly, async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const slaStatus =
    typeof req.query.slaStatus === 'string' ? req.query.slaStatus : undefined;
  const bidRequestId =
    typeof req.query.bidRequestId === 'string' ? req.query.bidRequestId : undefined;
  const take = parseLimit(req.query.limit, { defaultLimit: 50, max: 150 });
  const orders = await prisma.order.findMany({
    where: {
      ...(status ? { status: status as never } : {}),
      ...(slaStatus ? { slaStatus: slaStatus as never } : {}),
      ...(bidRequestId ? { bidRequestId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take,
    include: {
      bid: {
        select: {
          amountPaise: true,
          promisedDeliveryAt: true,
          supplier: { select: { publicLabel: true, businessName: true } },
        },
      },
      bidRequest: {
        select: {
          batchCode: true,
          deliveryWindow: true,
          preferredDeliverBy: true,
          consumer: { select: { restaurantName: true } },
        },
      },
    },
  });
  res.json({
    orders: orders.map((o) => ({
      id: o.id,
      orderCode: o.orderCode,
      status: o.status,
      slaStatus: o.slaStatus,
      slaDeadlineAt: o.slaDeadlineAt,
      createdAt: o.createdAt,
      bidRequestId: o.bidRequestId,
      amountPaise: o.bid?.amountPaise ?? 0,
      shopLabel: publicSupplierLabel(o.bid?.supplier),
      restaurantName: o.bidRequest?.consumer?.restaurantName ?? null,
      deliveryWindow: o.bidRequest?.deliveryWindow ?? null,
      batchCode: o.bidRequest?.batchCode ?? null,
      promisedDeliveryAt: o.bid?.promisedDeliveryAt ?? null,
    })),
  });
});

adminRouter.get('/admin/orders/:id', ...adminOnly, async (req, res) => {
  const id = requireParam(req, 'id');
  const order = assertFound(
    await prisma.order.findUnique({
      where: { id },
      include: {
        bid: {
          include: {
            supplier: {
              select: { publicLabel: true, businessName: true, userId: true },
            },
            bidLines: true,
          },
        },
        bidRequest: {
          include: {
            items: true,
            consumer: { select: { restaurantName: true, userId: true } },
          },
        },
        statusEvents: { orderBy: { createdAt: 'asc' }, take: 30 },
      },
    }),
  );
  const siblings = await prisma.order.findMany({
    where: { bidRequestId: order.bidRequestId, id: { not: order.id } },
    select: {
      id: true,
      orderCode: true,
      status: true,
      supplierUserId: true,
      bid: {
        select: {
          amountPaise: true,
          supplier: { select: { publicLabel: true, businessName: true } },
        },
      },
    },
  });
  res.json({
    order: {
      ...order,
      amountPaise: order.bid?.amountPaise ?? 0,
      shopLabel: publicSupplierLabel(order.bid?.supplier),
      restaurantName: order.bidRequest?.consumer?.restaurantName ?? null,
    },
    siblings: siblings.map((s) => ({
      id: s.id,
      orderCode: s.orderCode,
      status: s.status,
      supplierUserId: s.supplierUserId,
      amountPaise: s.bid?.amountPaise ?? 0,
      shopLabel: publicSupplierLabel(s.bid?.supplier),
    })),
  });
});

adminRouter.get('/admin/returns', ...adminOnly, async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const take = parseLimit(req.query.limit, { defaultLimit: 50, max: 150 });
  const claims = await prisma.returnClaim.findMany({
    where: status ? { status: status as never } : undefined,
    orderBy: { createdAt: 'desc' },
    take,
    include: {
      order: {
        select: {
          id: true,
          orderCode: true,
          status: true,
          bid: {
            select: {
              supplier: { select: { publicLabel: true, businessName: true } },
            },
          },
          bidRequest: {
            select: { consumer: { select: { restaurantName: true } } },
          },
        },
      },
      evidence: { select: { id: true, lineItemId: true, mediaType: true } },
    },
  });
  res.json({
    claims: claims.map((c) => ({
      ...c,
      orderCode: c.order?.orderCode ?? null,
      shopLabel: publicSupplierLabel(c.order?.bid?.supplier),
      restaurantName: c.order?.bidRequest?.consumer?.restaurantName ?? null,
      itemCount: c.lineItemIds.length,
    })),
  });
});

adminRouter.get('/admin/returns/:id', ...adminOnly, async (req, res) => {
  const id = requireParam(req, 'id');
  const claim = assertFound(
    await prisma.returnClaim.findUnique({
      where: { id },
      include: {
        evidence: true,
        order: {
          include: {
            bid: {
              select: {
                amountPaise: true,
                supplier: { select: { publicLabel: true, businessName: true } },
              },
            },
            bidRequest: {
              include: {
                items: true,
                consumer: { select: { restaurantName: true } },
              },
            },
          },
        },
      },
    }),
  );
  res.json({
    claim: {
      ...claim,
      shopLabel: publicSupplierLabel(claim.order?.bid?.supplier),
      restaurantName: claim.order?.bidRequest?.consumer?.restaurantName ?? null,
    },
  });
});

adminRouter.get('/admin/support/tickets', ...adminOnly, async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const take = parseLimit(req.query.limit, { defaultLimit: 50, max: 150 });
  const tickets = await prisma.supportTicket.findMany({
    where: status ? { status: status as never } : undefined,
    orderBy: { createdAt: 'desc' },
    take,
    include: {
      user: {
        select: {
          id: true,
          role: true,
          phone: true,
          displayName: true,
          consumerProfile: { select: { restaurantName: true } },
          supplierProfile: { select: { publicLabel: true, businessName: true } },
        },
      },
      _count: { select: { messages: true } },
    },
  });
  res.json({
    tickets: tickets.map((t) => ({
      ...t,
      restaurantName: t.user.consumerProfile?.restaurantName ?? null,
      shopLabel: t.user.supplierProfile
        ? publicSupplierLabel(t.user.supplierProfile)
        : null,
    })),
  });
});

adminRouter.get('/admin/support/tickets/:id', ...adminOnly, async (req, res) => {
  const id = requireParam(req, 'id');
  const ticket = assertFound(
    await prisma.supportTicket.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, role: true, phone: true, displayName: true } },
        messages: { orderBy: { createdAt: 'asc' }, take: 80 },
      },
    }),
  );
  res.json({ ticket });
});

adminRouter.get('/admin/support/articles', ...adminOnly, async (_req, res) => {
  const articles = await prisma.supportArticle.findMany({
    orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
    include: { category: { select: { title: true, slug: true } } },
  });
  res.json({ articles });
});

adminRouter.get('/admin/catalog/matrices', ...adminOnly, async (_req, res) => {
  const [shelf, windows] = await Promise.all([
    prisma.shelfLifeMatrix.findMany({ orderBy: { productCategory: 'asc' } }),
    prisma.returnWindowMatrix.findMany({ orderBy: { productCategory: 'asc' } }),
  ]);
  res.json({
    shelf: shelf.length > 0 ? shelf : PRODUCT_CATEGORIES.map((c) => ({
      productCategory: c.productCategory,
      totalShelfLifeDays: c.totalShelfLifeDays,
      minRslDays: c.minRslDays,
      notes: c.notes ?? null,
    })),
    returnWindows: windows.length > 0 ? windows : PRODUCT_CATEGORIES.map((c) => ({
      productCategory: c.productCategory,
      windowHours: c.windowHours,
      validReasons: c.validReasons,
      exampleItems: c.exampleItems,
    })),
  });
});

adminRouter.get('/admin/subscriptions', ...adminOnly, async (req, res) => {
  const take = parseLimit(req.query.limit, { defaultLimit: 60, max: 200 });
  const rows = await prisma.subscription.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    include: {
      user: {
        select: {
          id: true,
          role: true,
          phone: true,
          displayName: true,
          consumerProfile: { select: { restaurantName: true } },
          supplierProfile: { select: { publicLabel: true, businessName: true } },
        },
      },
    },
  });
  res.json({
    subscriptions: rows.map((s) => ({
      ...s,
      restaurantName: s.user.consumerProfile?.restaurantName ?? null,
      shopLabel: s.user.supplierProfile
        ? publicSupplierLabel(s.user.supplierProfile)
        : null,
      status: s.active ? 'active' : 'ended',
    })),
  });
});
