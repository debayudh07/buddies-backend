import { prisma } from '../../lib/prisma';
import { config } from '../../config';
import { AppError, assertFound } from '../../lib/errors';
import { emitChat } from '../../socket';

function orderCode() {
  return `ORD-${Date.now().toString().slice(-8)}`;
}

export async function createOrderFromAcceptedBid(bidId: string) {
  const bid = assertFound(
    await prisma.bid.findUnique({
      where: { id: bidId },
      include: {
        bidRequest: { include: { consumer: true, items: true } },
        supplier: true,
      },
    }),
  );

  // Consumer accept is binding and creates the order; supplier ack is tracked separately.
  if (!bid.consumerAckAt) {
    throw new AppError(400, 'ACK_REQUIRED', 'Consumer must accept the bid first');
  }

  const existing = await prisma.order.findUnique({ where: { bidId } });
  if (existing) return existing;

  const slaDeadlineAt = new Date(Date.now() + config.slaHours * 3600 * 1000);
  const consumer = bid.bidRequest.consumer;

  const order = await prisma.$transaction(async (tx) => {
    const created = await tx.order.create({
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
        consumerAckAt: bid.consumerAckAt,
        supplierAckAt: bid.supplierAckAt,
        statusEvents: {
          create: {
            status: 'bid_accepted',
            note: bid.supplierAckAt ? 'Order confirmed by both parties' : 'Won bid — order opened',
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
            lineSnapshotJson: bid.bidRequest.items.map((i, idx, arr) => ({
              name: i.name,
              quantity: i.quantity,
              unit: i.unit,
              productCategory: i.productCategory,
              grade: bid.grade,
              rslDaysAtDelivery: bid.rslDaysAtDelivery,
              // Full winning bid amount on first line; UI also uses order.totalPaise.
              amountPaise: idx === 0 ? bid.amountPaise : 0,
              lineTotalPaise: idx === 0 ? bid.amountPaise : 0,
              isWinningBidTotal: idx === 0,
              itemCount: arr.length,
            })),
          },
        },
      },
      include: { chatThread: true, offlinePayment: true, digitalChallan: true },
    });
    return created;
  });

  if (order.chatThread) {
    emitChat(order.chatThread.id, 'chat.thread_created', { threadId: order.chatThread.id, orderId: order.id });
  }

  return order;
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
