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

export async function createOrderFromAcceptedBid(bidId: string) {
  const bid = assertFound(
    await prisma.bid.findUnique({
      where: { id: bidId },
      include: {
        bidRequest: { include: { consumer: true, items: true } },
        supplier: true,
        bidLines: true,
      },
    }),
  );

  // Consumer accept is binding and creates the order; supplier ack is tracked separately.
  if (!bid.consumerAckAt) {
    throw new AppError(400, 'ACK_REQUIRED', 'Consumer must accept the bid first');
  }

  // Race-safe: another accept concurrent path may already have inserted.
  const existing = await prisma.order.findUnique({
    where: { bidId },
    include: orderInclude,
  });
  if (existing) return existing;

  const slaDeadlineAt = new Date(Date.now() + config.slaHours * 3600 * 1000);
  const consumer = bid.bidRequest.consumer;

  try {
    const order = await prisma.$transaction(async (tx) => {
      const again = await tx.order.findUnique({
        where: { bidId },
        include: orderInclude,
      });
      if (again) return again;

      const coveredItems = bid.coveredItemIds.length > 0
        ? bid.bidRequest.items.filter((i) => bid.coveredItemIds.includes(i.id))
        : bid.bidRequest.items;

      return tx.order.create({
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
          deliveryAddress:
            bid.bidRequest.deliveryAddress ?? consumer.addressLine ?? null,
          coveredItemIds: bid.coveredItemIds.length > 0 ? bid.coveredItemIds : bid.bidRequest.items.map((i) => i.id),
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
                const amount = line ? line.amountPaise : (bid.coveredItemIds.length > 0 ? 0 : (idx === 0 ? bid.amountPaise : 0));
                return {
                  name: i.name,
                  quantity: i.quantity,
                  unit: i.unit,
                  productCategory: i.productCategory,
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
    });

    if (order.chatThread) {
      emitChat(order.chatThread.id, 'chat.thread_created', {
        threadId: order.chatThread.id,
        orderId: order.id,
      });
    }

    return order;
  } catch (e: unknown) {
    // Unique violation on bidId under concurrent accept
    const code = (e as { code?: string })?.code;
    if (code === 'P2002') {
      const recovered = await prisma.order.findUnique({ where: { bidId }, include: orderInclude });
      if (recovered) return recovered;
    }
    throw e;
  }
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
