import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { config } from '../../config';
import { AppError, assertFound } from '../../lib/errors';
import { emitChat } from '../../socket';

function orderCode() {
  return `ORD-${Date.now().toString().slice(-8)}`;
}

const orderInclude = {
  chatThread: true,
  offlinePayment: true,
  digitalChallan: true,
} as const;

type DbClient = Prisma.TransactionClient | typeof prisma;

export type AwardOrderOptions = {
  /** Exact items awarded to this bid; defaults to the bid's covered set / full request. */
  coveredItemIds?: string[];
  tx?: Prisma.TransactionClient;
  emitRealtime?: boolean;
};

function resolveCoveredItemIds(
  bid: {
    coveredItemIds: string[];
    bidRequest: { items: Array<{ id: string }> };
  },
  override?: string[],
): string[] {
  if (override && override.length > 0) return [...new Set(override)];
  if (bid.coveredItemIds.length > 0) return bid.coveredItemIds;
  return bid.bidRequest.items.map((i) => i.id);
}

async function insertOrderFromBid(
  db: DbClient,
  bid: NonNullable<Awaited<ReturnType<typeof loadAcceptedBid>>>,
  coveredItemIds: string[],
) {
  const existing = await db.order.findUnique({
    where: { bidId: bid.id },
    include: orderInclude,
  });
  if (existing) return existing;

  const slaDeadlineAt = new Date(Date.now() + config.slaHours * 3600 * 1000);
  const consumer = bid.bidRequest.consumer;
  const coveredItems = bid.bidRequest.items.filter((i) => coveredItemIds.includes(i.id));

  return db.order.create({
    data: {
      orderCode: orderCode(),
      bidRequestId: bid.bidRequestId,
      bidId: bid.id,
      consumerUserId: consumer.userId,
      supplierUserId: bid.supplier.userId,
      status: 'bid_accepted',
      slaDeadlineAt,
      slaStatus: 'on_track',
      deliveryLat: bid.bidRequest.lat ?? consumer.lat ?? undefined,
      deliveryLng: bid.bidRequest.lng ?? consumer.lng ?? undefined,
      deliveryAddress: bid.bidRequest.deliveryAddress ?? consumer.addressLine ?? null,
      coveredItemIds,
      consumerAckAt: bid.consumerAckAt,
      supplierAckAt: bid.supplierAckAt,
      statusEvents: {
        create: {
          status: 'bid_accepted',
          note: bid.supplierAckAt
            ? 'Order confirmed by both parties'
            : 'Won bid — order opened (bind-on-accept)',
        },
      },
      offlinePayment: { create: { status: 'not_started' } },
      chatThread: {
        create: {
          consumerUserId: consumer.userId,
          supplierUserId: bid.supplier.userId,
        },
      },
      digitalChallan: {
        create: {
          isDraft: true,
          lineSnapshotJson: coveredItems.map((i, idx, arr) => {
            const line = bid.bidLines?.find((l) => l.bidRequestItemId === i.id);
            const amount = line
              ? line.amountPaise
              : bid.coveredItemIds.length > 0
                ? 0
                : idx === 0
                  ? bid.amountPaise
                  : 0;
            return {
              name: i.name,
              quantity: i.quantity,
              unit: i.unit,
              productCategory: i.productCategory,
              catalogCategory: i.catalogCategory,
              catalogItemSlug: i.catalogItemSlug,
              grade: bid.grade,
              rslDaysAtDelivery: bid.rslDaysAtDelivery,
              amountPaise: amount,
              lineTotalPaise: amount,
              isWinningBidTotal: line ? true : idx === 0,
              itemCount: arr.length,
            };
          }),
        },
      },
    },
    include: orderInclude,
  });
}

async function loadAcceptedBid(db: DbClient, bidId: string) {
  return db.bid.findUnique({
    where: { id: bidId },
    include: {
      bidRequest: { include: { consumer: true, items: true } },
      supplier: true,
      bidLines: true,
    },
  });
}

/** Binding accept path: one order per winning bid, scoped to the awarded item snapshots. */
export async function createOrderFromAcceptedBid(bidId: string, opts?: AwardOrderOptions) {
  const db: DbClient = opts?.tx ?? prisma;
  const bid = assertFound(await loadAcceptedBid(db, bidId));

  if (!bid.consumerAckAt) {
    throw new AppError(400, 'ACK_REQUIRED', 'Consumer must accept the bid first');
  }

  const coveredItemIds = resolveCoveredItemIds(bid, opts?.coveredItemIds);
  const emitRealtime = opts?.emitRealtime ?? !opts?.tx;

  try {
    const order = opts?.tx
      ? await insertOrderFromBid(opts.tx, bid, coveredItemIds)
      : await prisma.$transaction(async (tx) => insertOrderFromBid(tx, bid, coveredItemIds));

    if (emitRealtime && order.chatThread) {
      emitChat(order.chatThread.id, 'chat.thread_created', {
        threadId: order.chatThread.id,
        orderId: order.id,
      });
    }

    return order;
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code === 'P2002') {
      const recovered = await db.order.findUnique({ where: { bidId }, include: orderInclude });
      if (recovered) return recovered;
    }
    throw e;
  }
}

export function emitOrderChatCreated(order: { id: string; chatThread?: { id: string } | null }) {
  if (!order.chatThread) return;
  emitChat(order.chatThread.id, 'chat.thread_created', {
    threadId: order.chatThread.id,
    orderId: order.id,
  });
}

export async function updateSupplierPerformanceOnDelivery(supplierUserId: string, onTime: boolean) {
  const profile = await prisma.supplierProfile.findUnique({ where: { userId: supplierUserId } });
  if (!profile) return;
  const alpha = 0.2;
  const sample = onTime ? 100 : 0;
  const onTimeRate = profile.onTimeRate * (1 - alpha) + sample * alpha;
  await prisma.supplierProfile.update({
    where: { id: profile.id },
    data: { onTimeRate: Math.round(onTimeRate * 10) / 10 },
  });
}

export async function bumpReturnRate(supplierUserId: string, increased: boolean) {
  const profile = await prisma.supplierProfile.findUnique({ where: { userId: supplierUserId } });
  if (!profile) return;
  const alpha = 0.15;
  const sample = increased ? 100 : 0;
  const returnRate = profile.returnRate * (1 - alpha) + sample * alpha;
  await prisma.supplierProfile.update({
    where: { id: profile.id },
    data: { returnRate: Math.round(returnRate * 10) / 10 },
  });
}
